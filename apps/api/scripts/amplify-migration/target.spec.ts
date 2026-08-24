import { createHash } from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MigrationBundle } from './contracts';
import {
  FileCheckpointStore,
  MigrationImportError,
  formatImportCliError,
  importMigrationBundle,
  parseImportCliOptions,
  runImportCli,
  type ImportCheckpoint,
  type ImportStage,
} from './import';
import {
  AwsMigrationTarget,
  TARGET_MODEL_ORDER,
  amplifyDataTargetRecord,
  assertExplicitTargetConfiguration,
  type AwsMigrationClients,
  type MigrationModelName,
  type MigrationTarget,
  type TargetConfiguration,
} from './target';
import {
  parseVerifyCliOptions,
  runVerifyCli,
  verifyMigrationTarget,
} from './verify';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'fsk-target-test-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const S3_SINGLE_PUT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;

function zeroFileSha256(byteSize: number): string {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(STREAM_CHUNK_BYTES);
  for (let offset = 0; offset < byteSize; offset += chunk.length) {
    hash.update(chunk.subarray(0, Math.min(chunk.length, byteSize - offset)));
  }
  return hash.digest('hex');
}

function fixtureBundle(): MigrationBundle {
  const report = {
    reportKey: '2026-08-24#shift-day',
    businessDate: '2026-08-24',
    shiftId: 'shift-day',
    shiftNameSnapshot: '白班',
    responsiblePersonId: 'person-1',
    responsiblePersonSnapshot: '张三',
    startMinuteOfDay: 600,
    endMinuteOfDay: 900,
    timeRangeLabelSnapshot: '10:00 - 15:00',
    previousImosBalanceYen: 10_000,
    currentImosBalanceYen: 16_000,
    newageYen: 8_000,
    cashTotalYen: 20_000,
    expenseYen: 300,
    expenseReason: '买菜',
    staffMealCashYen: 1_200,
    staffMealAlipayYen: 800,
    attachmentKeys: [] as string[],
    submittedAt: '2026-08-24T15:00:00.000Z',
    legacySubmittedByUsername: 'legacy-kitchen',
  };
  return {
    shifts: [
      { id: 'shift-day', name: '白班', sortOrder: 10, active: true },
    ],
    responsiblePersons: [
      { id: 'person-1', name: '张三', active: true },
    ],
    appSetting: {
      id: 'default',
      registerFloatAmount: 5_000,
      setupCompleted: true,
    },
    dailyReports: [report],
    attachments: [],
    sourceSummary: {
      modelCounts: {
        shifts: 1,
        responsiblePersons: 1,
        appSettings: 1,
        dailyReports: 1,
        attachments: 0,
      },
      amounts: {
        byBusinessDate: {
          '2026-08-24': {
            raw: {
              previousImosBalanceYen: 10_000,
              currentImosBalanceYen: 16_000,
              newageYen: 8_000,
              cashTotalYen: 20_000,
              expenseYen: 300,
              staffMealCashYen: 1_200,
              staffMealAlipayYen: 800,
            },
            derived: {
              imosSalesYen: 6_000,
              cashDepositYen: 15_000,
              totalSalesYen: 21_800,
              deviationYen: 16_100,
              staffMealTotalYen: 2_000,
            },
          },
        },
        global: {
          raw: {
            previousImosBalanceYen: 10_000,
            currentImosBalanceYen: 16_000,
            newageYen: 8_000,
            cashTotalYen: 20_000,
            expenseYen: 300,
            staffMealCashYen: 1_200,
            staffMealAlipayYen: 800,
          },
          derived: {
            imosSalesYen: 6_000,
            cashDepositYen: 15_000,
            totalSalesYen: 21_800,
            deviationYen: 16_100,
            staffMealTotalYen: 2_000,
          },
        },
      },
      sourceUploadSummary: { count: 0, totalBytes: 0, hashes: [] },
      targetAttachmentSummary: { count: 0, totalBytes: 0, hashes: [] },
      warnings: [],
      conflicts: [],
      orphans: [],
    },
  };
}

class MemoryTarget implements MigrationTarget {
  readonly records = new Map<string, unknown>();
  readonly attachments = new Map<string, { byteSize: number; sha256: string }>();
  readonly calls: string[] = [];
  failOnceAt?: string;
  mutatingCalls = 0;

  async assertSafeTarget(): Promise<void> {
    this.calls.push('preflight');
  }

  async putRecord(
    model: MigrationModelName,
    key: string,
    record: Record<string, unknown>,
  ): Promise<'created' | 'unchanged'> {
    this.calls.push(`${model}:${key}`);
    this.mutatingCalls += 1;
    const composite = `${model}:${key}`;
    if (this.failOnceAt === composite) {
      this.failOnceAt = undefined;
      throw new Error('SYNTHETIC_PARTIAL_FAILURE');
    }
    const normalized = JSON.stringify(record, Object.keys(record).sort());
    const existing = this.records.get(composite);
    if (existing === undefined) {
      this.records.set(composite, JSON.parse(normalized));
      return 'created';
    }
    if (JSON.stringify(existing) === normalized) return 'unchanged';
    throw new Error(`TARGET_RECORD_CONFLICT:${model}:${key}`);
  }

  async putAttachment(
    entry: MigrationBundle['attachments'][number],
    sourcePath: string,
    _uploadsRoot: string,
  ): Promise<'created' | 'unchanged'> {
    this.calls.push(`Attachment:${entry.objectKey}`);
    this.mutatingCalls += 1;
    const hash = createHash('sha256');
    let byteSize = 0;
    for await (const chunk of createReadStream(sourcePath, {
      highWaterMark: STREAM_CHUNK_BYTES,
    })) {
      byteSize += chunk.byteLength;
      hash.update(chunk);
    }
    const digest = hash.digest('hex');
    const existing = this.attachments.get(entry.objectKey);
    if (existing) {
      if (existing.sha256 === digest && existing.byteSize === byteSize) {
        return 'unchanged';
      }
      throw new Error(`TARGET_ATTACHMENT_CONFLICT:${entry.objectKey}`);
    }
    this.attachments.set(entry.objectKey, { byteSize, sha256: digest });
    return 'created';
  }

  async listRecords(model: MigrationModelName): Promise<Record<string, unknown>[]> {
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(`${model}:`))
      .map(([, value]) => value as Record<string, unknown>);
  }

  async assertAttachmentObjectKeys(expected: ReadonlySet<string>): Promise<void> {
    const actual = new Set(this.attachments.keys());
    if (
      actual.size !== expected.size ||
      [...expected].some((key) => !actual.has(key))
    ) {
      throw new Error('TARGET_VERIFICATION_MISMATCH:attachmentKeys');
    }
  }

  async readAttachment(objectKey: string): Promise<{ byteSize: number; sha256: string }> {
    const value = this.attachments.get(objectKey);
    if (!value) throw new Error(`TARGET_ATTACHMENT_NOT_FOUND:${objectKey}`);
    return value;
  }
}

class MemoryCheckpointStore {
  checkpoint: ImportCheckpoint | null = null;

  async load(): Promise<ImportCheckpoint | null> {
    return this.checkpoint === null
      ? null
      : JSON.parse(JSON.stringify(this.checkpoint));
  }

  async saveAtomic(checkpoint: ImportCheckpoint): Promise<void> {
    this.checkpoint = JSON.parse(JSON.stringify(checkpoint));
  }
}

function addAttachment(bundle: MigrationBundle, uploadsRoot: string): void {
  const contents = 'receipt-one';
  const digest = sha256(contents);
  const relativeKey = 'legacy-report-1/receipt.txt';
  mkdirSync(join(uploadsRoot, 'legacy-report-1'));
  writeFileSync(join(uploadsRoot, relativeKey), contents);
  const objectKey = `migration/daily-reports/2026-08-24#shift-day/${digest}-receipt.txt`;
  bundle.attachments.push({
    sourceRelativeKey: relativeKey,
    objectKey,
    byteSize: Buffer.byteLength(contents),
    sha256: digest,
    reportKey: '2026-08-24#shift-day',
  });
  bundle.dailyReports[0].attachmentKeys = [objectKey];
  bundle.sourceSummary.modelCounts.attachments = 1;
  bundle.sourceSummary.targetAttachmentSummary = {
    count: 1,
    totalBytes: Buffer.byteLength(contents),
    hashes: [{ objectKey, sha256: digest }],
  };
}

describe('migration apply orchestration', () => {
  it('rejects an attachment over the conditional single-PutObject limit before target preflight', async () => {
    const root = temporaryRoot();
    const bundle = fixtureBundle();
    addAttachment(bundle, root);
    bundle.attachments[0].byteSize = S3_SINGLE_PUT_MAX_BYTES + 1;
    const target = new MemoryTarget();
    await expect(
      importMigrationBundle({
        mode: 'apply',
        approvalId: 'FSK-TASK11-SYNTHETIC-OVERSIZE',
        bundle,
        uploadsRoot: root,
        target,
        checkpointStore: new MemoryCheckpointStore(),
      }),
    ).rejects.toThrow('IMPORT_ATTACHMENT_EXCEEDS_CONDITIONAL_PUT_LIMIT');
    expect(target.calls).toEqual([]);
  });

  it('materializes deterministic Amplify Data createdAt and updatedAt fields for every target model', async () => {
    const bundle = fixtureBundle();
    const target = new MemoryTarget();
    await importMigrationBundle({
      mode: 'apply',
      approvalId: 'FSK-TASK11-SYNTHETIC-TIMESTAMPS',
      bundle,
      uploadsRoot: temporaryRoot(),
      target,
      checkpointStore: new MemoryCheckpointStore(),
    });

    const technicalSentinel = '1970-01-01T00:00:00.000Z';
    for (const key of [
      'ShiftDefinition:shift-day',
      'ResponsiblePerson:person-1',
      'AppSetting:default',
    ]) {
      expect(target.records.get(key)).toMatchObject({
        createdAt: technicalSentinel,
        updatedAt: technicalSentinel,
      });
    }
    expect(
      target.records.get('DailyReport:2026-08-24#shift-day'),
    ).toMatchObject({
      createdAt: bundle.dailyReports[0].submittedAt,
      updatedAt: bundle.dailyReports[0].submittedAt,
    });
    expect(JSON.stringify([...target.records.values()])).not.toMatch(
      /__typename|_version/,
    );
  });

  it('rechecks every target stage from a completed checkpoint and reports identical input as no-op', async () => {
    const root = temporaryRoot();
    const bundle = fixtureBundle();
    addAttachment(bundle, root);
    const target = new MemoryTarget();
    const checkpoint = new MemoryCheckpointStore();

    const first = await importMigrationBundle({
      mode: 'apply',
      approvalId: 'FSK-TASK11-SYNTHETIC-1',
      bundle,
      uploadsRoot: root,
      target,
      checkpointStore: checkpoint,
    });
    const firstCalls = [...target.calls];
    target.calls.length = 0;
    const second = await importMigrationBundle({
      mode: 'apply',
      approvalId: 'FSK-TASK11-SYNTHETIC-1',
      bundle,
      uploadsRoot: root,
      target,
      checkpointStore: checkpoint,
    });

    expect(first.created).toEqual({ records: 4, attachments: 1 });
    expect(second.unchanged).toEqual({ records: 4, attachments: 1 });
    expect(second.created).toEqual({ records: 0, attachments: 0 });
    expect(firstCalls).toEqual([
      'preflight',
      'ShiftDefinition:shift-day',
      'ResponsiblePerson:person-1',
      'AppSetting:default',
      'DailyReport:2026-08-24#shift-day',
      `Attachment:${bundle.attachments[0].objectKey}`,
    ]);
    expect(target.calls).toEqual(firstCalls);
    expect(TARGET_MODEL_ORDER).toEqual([
      'ShiftDefinition',
      'ResponsiblePerson',
      'AppSetting',
      'DailyReport',
    ]);
  });

  it('resumes only unfinished stages from an in-progress checkpoint', async () => {
    const bundle = fixtureBundle();
    const target = new MemoryTarget();
    const checkpoint = new MemoryCheckpointStore();
    await importMigrationBundle({
      mode: 'apply',
      approvalId: 'FSK-TASK11-SYNTHETIC-IN-PROGRESS',
      bundle,
      uploadsRoot: temporaryRoot(),
      target,
      checkpointStore: checkpoint,
    });
    checkpoint.checkpoint = {
      ...checkpoint.checkpoint!,
      status: 'in-progress',
      completedStages: ['ShiftDefinition', 'ResponsiblePerson'],
    };
    target.calls.length = 0;

    const resumed = await importMigrationBundle({
      mode: 'apply',
      approvalId: 'FSK-TASK11-SYNTHETIC-IN-PROGRESS',
      bundle,
      uploadsRoot: temporaryRoot(),
      target,
      checkpointStore: checkpoint,
    });

    expect(resumed.unchanged).toEqual({ records: 2, attachments: 0 });
    expect(target.calls).toEqual([
      'preflight',
      'AppSetting:default',
      'DailyReport:2026-08-24#shift-day',
    ]);
  });

  it('stops after a partial failure and resumes deterministically without overwriting', async () => {
    const bundle = fixtureBundle();
    const target = new MemoryTarget();
    const checkpoint = new MemoryCheckpointStore();
    target.failOnceAt = 'DailyReport:2026-08-24#shift-day';

    await expect(
      importMigrationBundle({
        mode: 'apply',
        approvalId: 'FSK-TASK11-SYNTHETIC-2',
        bundle,
        uploadsRoot: temporaryRoot(),
        target,
        checkpointStore: checkpoint,
      }),
    ).rejects.toThrow('MIGRATION_IMPORT_FAILED:DailyReport');

    expect(checkpoint.checkpoint).toMatchObject({
      status: 'failed',
      completedStages: [
        'ShiftDefinition',
        'ResponsiblePerson',
        'AppSetting',
      ],
      failedStage: 'DailyReport',
      failureCode: 'SYNTHETIC_PARTIAL_FAILURE',
    });
    const resumed = await importMigrationBundle({
      mode: 'apply',
      approvalId: 'FSK-TASK11-SYNTHETIC-2',
      bundle,
      uploadsRoot: temporaryRoot(),
      target,
      checkpointStore: checkpoint,
    });
    expect(resumed.status).toBe('complete');
    expect(resumed.created.records).toBe(1);
    expect(target.records.size).toBe(4);
  });

  it('preserves the target failure when atomic checkpoint persistence also fails', async () => {
    const target = new MemoryTarget();
    target.failOnceAt = 'ShiftDefinition:shift-day';
    let saves = 0;
    const checkpointStore = {
      async load(): Promise<null> {
        return null;
      },
      async saveAtomic(): Promise<void> {
        saves += 1;
        if (saves > 1) throw new Error('CHECKPOINT_DISK_FAILURE');
      },
    };
    let caught: unknown;
    try {
      await importMigrationBundle({
        mode: 'apply',
        approvalId: 'FSK-TASK11-SYNTHETIC-CHECKPOINT-FAIL',
        bundle: fixtureBundle(),
        uploadsRoot: temporaryRoot(),
        target,
        checkpointStore,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'MIGRATION_IMPORT_FAILED',
      stage: 'ShiftDefinition',
      failureCode: 'SYNTHETIC_PARTIAL_FAILURE',
      checkpointPersisted: false,
      checkpointFailureCode: 'CHECKPOINT_DISK_FAILURE',
    });
  });

  it('preserves a sanitized unknown attachment Put outcome in the deterministic checkpoint', async () => {
    const root = temporaryRoot();
    const bundle = fixtureBundle();
    addAttachment(bundle, root);
    const target = new MemoryTarget();
    const checkpoint = new MemoryCheckpointStore();
    const outcomeCode =
      `TARGET_ATTACHMENT_PUT_OUTCOME_UNKNOWN:${bundle.attachments[0].objectKey}`;
    target.putAttachment = async () => {
      throw new Error(outcomeCode);
    };
    await expect(
      importMigrationBundle({
        mode: 'apply',
        approvalId: 'FSK-TASK11-SYNTHETIC-UNKNOWN-PUT',
        bundle,
        uploadsRoot: root,
        target,
        checkpointStore: checkpoint,
      }),
    ).rejects.toMatchObject({ failureCode: outcomeCode });
    expect(checkpoint.checkpoint).toMatchObject({
      status: 'failed',
      failedStage: 'Attachment',
      failureCode: outcomeCode,
    });
  });

  it('fails closed when the same key contains different normalized content', async () => {
    const bundle = fixtureBundle();
    const target = new MemoryTarget();
    const checkpoint = new MemoryCheckpointStore();
    await importMigrationBundle({
      mode: 'apply',
      approvalId: 'FSK-TASK11-SYNTHETIC-3',
      bundle,
      uploadsRoot: temporaryRoot(),
      target,
      checkpointStore: checkpoint,
    });
    checkpoint.checkpoint = null;
    bundle.shifts[0].name = '不同班次';

    await expect(
      importMigrationBundle({
        mode: 'apply',
        approvalId: 'FSK-TASK11-SYNTHETIC-3',
        bundle,
        uploadsRoot: temporaryRoot(),
        target,
        checkpointStore: checkpoint,
      }),
    ).rejects.toThrow('MIGRATION_IMPORT_FAILED:ShiftDefinition');
    expect(target.records.get('ShiftDefinition:shift-day')).toMatchObject({
      name: '白班',
    });
    expect(checkpoint.checkpoint).toMatchObject({
      status: 'failed',
      failedStage: 'ShiftDefinition',
      failureCode: 'TARGET_RECORD_CONFLICT:ShiftDefinition:shift-day',
    });
  });

  it('dry-run performs no target preflight or mutating calls', async () => {
    const target = new MemoryTarget();
    const checkpoint = new MemoryCheckpointStore();
    const result = await importMigrationBundle({
      mode: 'dry-run',
      bundle: fixtureBundle(),
      uploadsRoot: temporaryRoot(),
      target,
      checkpointStore: checkpoint,
    });
    expect(result.status).toBe('dry-run');
    expect(target.calls).toEqual([]);
    expect(target.mutatingCalls).toBe(0);
    expect(checkpoint.checkpoint).toBeNull();
  });

  it('rejects a non-linked Task10 attachment contract before target preflight or writes', async () => {
    const root = temporaryRoot();
    const bundle = fixtureBundle();
    addAttachment(bundle, root);
    bundle.attachments[0].reportKey = '2026-08-24#unknown-shift';
    const target = new MemoryTarget();
    await expect(
      importMigrationBundle({
        mode: 'apply',
        approvalId: 'FSK-TASK11-SYNTHETIC-BAD-BUNDLE',
        bundle,
        uploadsRoot: root,
        target,
        checkpointStore: new MemoryCheckpointStore(),
      }),
    ).rejects.toThrow('IMPORT_ATTACHMENT_BUNDLE_CONTRACT_INVALID');
    expect(target.calls).toEqual([]);
    expect(target.mutatingCalls).toBe(0);
  });

  it('rejects an attachment source traversal before any record stage starts', async () => {
    const root = temporaryRoot();
    const bundle = fixtureBundle();
    addAttachment(bundle, root);
    bundle.attachments[0].sourceRelativeKey = '../receipt.txt';
    const target = new MemoryTarget();
    await expect(
      importMigrationBundle({
        mode: 'apply',
        approvalId: 'FSK-TASK11-SYNTHETIC-TRAVERSAL',
        bundle,
        uploadsRoot: root,
        target,
        checkpointStore: new MemoryCheckpointStore(),
      }),
    ).rejects.toThrow('IMPORT_ATTACHMENT_BUNDLE_CONTRACT_INVALID');
    expect(target.calls).toEqual([]);
  });

  it('rejects legacy credential, role, or owner fields injected into the bundle before writes', async () => {
    for (const [field, value] of [
      ['passwordHash', '$2b$forbidden'],
      ['role', 'WEBMASTER'],
      ['owner', 'forged-subject'],
    ]) {
      const bundle = fixtureBundle();
      (bundle.dailyReports[0] as unknown as Record<string, unknown>)[field] = value;
      const target = new MemoryTarget();
      await expect(
        importMigrationBundle({
          mode: 'apply',
          approvalId: 'FSK-TASK11-SYNTHETIC-BAD-FIELD',
          bundle,
          uploadsRoot: temporaryRoot(),
          target,
          checkpointStore: new MemoryCheckpointStore(),
        }),
      ).rejects.toThrow('IMPORT_BUNDLE_RECORD_UNKNOWN_FIELD:DailyReport');
      expect(target.calls).toEqual([]);
    }
  });

  it('validates target record keys, raw amounts, and master identifiers before preflight', async () => {
    const invalidBundles = [
      (() => {
        const bundle = fixtureBundle();
        bundle.dailyReports[0].reportKey = '2026-08-24#wrong';
        return bundle;
      })(),
      (() => {
        const bundle = fixtureBundle();
        (bundle.dailyReports[0] as unknown as Record<string, unknown>).cashTotalYen = -1;
        return bundle;
      })(),
      (() => {
        const bundle = fixtureBundle();
        bundle.shifts[0].id = '   ';
        return bundle;
      })(),
    ];
    for (const bundle of invalidBundles) {
      const target = new MemoryTarget();
      await expect(
        importMigrationBundle({
          mode: 'apply',
          approvalId: 'FSK-TASK11-SYNTHETIC-INVALID-RECORD',
          bundle,
          uploadsRoot: temporaryRoot(),
          target,
          checkpointStore: new MemoryCheckpointStore(),
        }),
      ).rejects.toThrow(/IMPORT_BUNDLE_RECORD_INVALID/);
      expect(target.calls).toEqual([]);
    }
  });

  it('rejects a bundle whose source model or accounting summary does not match its records', async () => {
    const bundle = fixtureBundle();
    bundle.sourceSummary.amounts.global.raw.staffMealCashYen = 999;
    const target = new MemoryTarget();
    await expect(
      importMigrationBundle({
        mode: 'apply',
        approvalId: 'FSK-TASK11-SYNTHETIC-BAD-SUMMARY',
        bundle,
        uploadsRoot: temporaryRoot(),
        target,
        checkpointStore: new MemoryCheckpointStore(),
      }),
    ).rejects.toThrow('IMPORT_BUNDLE_SUMMARY_MISMATCH');
    expect(target.calls).toEqual([]);
  });
});

describe('checkpoint and CLI safety', () => {
  it('reports an import partial outcome without hiding checkpoint persistence state', () => {
    const error = new MigrationImportError(
      'DailyReport',
      'TARGET_RECORD_CONFLICT:DailyReport:2026-08-24#shift-day',
      false,
      'UNCLASSIFIED_TARGET_FAILURE',
    );
    expect(formatImportCliError(error)).toEqual({
      code: 'MIGRATION_IMPORT_FAILED',
      stage: 'DailyReport',
      failureCode: 'TARGET_RECORD_CONFLICT:DailyReport:2026-08-24#shift-day',
      checkpointPersisted: false,
      checkpointFailureCode: 'UNCLASSIFIED_TARGET_FAILURE',
    });
  });

  it('writes deterministic checkpoint JSON atomically without secret fields', async () => {
    const root = temporaryRoot();
    const path = join(root, 'checkpoint.json');
    const store = new FileCheckpointStore(path);
    const checkpoint: ImportCheckpoint = {
      version: 1,
      bundleSha256: sha256('bundle'),
      targetFingerprint: sha256('target'),
      status: 'failed',
      completedStages: ['ShiftDefinition'],
      failedStage: 'ResponsiblePerson',
      failureCode: 'SYNTHETIC_FAILURE',
    };
    await store.saveAtomic(checkpoint);
    const first = readFileSync(path, 'utf8');
    await store.saveAtomic(checkpoint);
    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(JSON.parse(first)).toEqual(checkpoint);
    expect(first).not.toMatch(/password|secret|token|credential/i);
  });

  it('rejects a checkpoint that skips or reorders import stages', async () => {
    const root = temporaryRoot();
    const path = join(root, 'checkpoint.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        bundleSha256: sha256('bundle'),
        targetFingerprint: sha256('target'),
        status: 'in-progress',
        completedStages: ['ShiftDefinition', 'DailyReport'],
      }),
    );
    await expect(new FileCheckpointStore(path).load()).rejects.toThrow(
      'IMPORT_CHECKPOINT_INVALID',
    );
  });

  it.each([
    { argv: [], error: null, mode: 'dry-run' },
    { argv: ['--apply'], error: 'IMPORT_APPROVAL_ID_REQUIRED' },
    {
      argv: ['--apply', '--approval-id', '   '],
      error: 'IMPORT_APPROVAL_ID_REQUIRED',
    },
    {
      argv: ['--apply', '--approval-id', 'FSK-1'],
      error: 'IMPORT_TARGET_CONFIG_REQUIRED',
    },
  ])('requires explicit apply approval and target config: $argv', ({ argv, error, mode }) => {
    if (error) {
      expect(() => parseImportCliOptions(argv)).toThrow(error);
    } else {
      expect(parseImportCliOptions(argv).mode).toBe(mode);
    }
  });

  it('keeps independent verification local by default and requires explicit target inputs', async () => {
    expect(parseVerifyCliOptions([])).toEqual({
      mode: 'dry-run',
      bundlePath: undefined,
      targetConfigPath: undefined,
    });
    await expect(runVerifyCli([])).resolves.toEqual({ status: 'dry-run' });
    expect(() => parseVerifyCliOptions(['--verify'])).toThrow(
      'VERIFY_BUNDLE_REQUIRED',
    );
    expect(() =>
      parseVerifyCliOptions(['--verify', '--bundle', '/tmp/bundle.json']),
    ).toThrow('VERIFY_TARGET_CONFIG_REQUIRED');
  });

  it('runs the default import CLI dry-run against a synthetic bundle without target clients', async () => {
    const root = temporaryRoot();
    const bundlePath = join(root, 'bundle.json');
    writeFileSync(bundlePath, JSON.stringify(fixtureBundle()));
    await expect(
      runImportCli([
        '--bundle',
        bundlePath,
        '--uploads-root',
        root,
        '--checkpoint',
        join(root, 'checkpoint.json'),
      ]),
    ).resolves.toMatchObject({ status: 'dry-run' });
    expect(readFileSync(bundlePath, 'utf8')).toBe(JSON.stringify(fixtureBundle()));
  });
});

function targetConfiguration(): TargetConfiguration {
  const stack = (name: string) => ({
    name,
    arn: `arn:aws:cloudformation:ap-northeast-1:444083008754:stack/${name}/uuid`,
  });
  return {
    accountId: '444083008754',
    region: 'ap-northeast-1',
    amplifyApp: { appId: 'fskapp123', name: 'FSK' },
    stacks: {
      auth: stack('amplify-fskapp123-production-auth-uuid'),
      data: stack('amplify-fskapp123-production-data-uuid'),
      storage: stack('amplify-fskapp123-production-storage-uuid'),
      function: stack('amplify-fskapp123-production-function-uuid'),
    },
    tables: {
      ShiftDefinition: {
        name: 'ShiftDefinition-fskapp123-production',
        arn: 'arn:aws:dynamodb:ap-northeast-1:444083008754:table/ShiftDefinition-fskapp123-production',
        stackName: 'amplify-fskapp123-production-data-uuid',
      },
      ResponsiblePerson: {
        name: 'ResponsiblePerson-fskapp123-production',
        arn: 'arn:aws:dynamodb:ap-northeast-1:444083008754:table/ResponsiblePerson-fskapp123-production',
        stackName: 'amplify-fskapp123-production-data-uuid',
      },
      AppSetting: {
        name: 'AppSetting-fskapp123-production',
        arn: 'arn:aws:dynamodb:ap-northeast-1:444083008754:table/AppSetting-fskapp123-production',
        stackName: 'amplify-fskapp123-production-data-uuid',
      },
      DailyReport: {
        name: 'DailyReport-fskapp123-production',
        arn: 'arn:aws:dynamodb:ap-northeast-1:444083008754:table/DailyReport-fskapp123-production',
        stackName: 'amplify-fskapp123-production-data-uuid',
      },
    },
    bucket: {
      name: 'fskapp123-production-storage',
      arn: 'arn:aws:s3:::fskapp123-production-storage',
      stackName: 'amplify-fskapp123-production-storage-uuid',
    },
    userPool: {
      id: 'ap-northeast-1_FSK123',
      arn: 'arn:aws:cognito-idp:ap-northeast-1:444083008754:userpool/ap-northeast-1_FSK123',
      stackName: 'amplify-fskapp123-production-auth-uuid',
    },
  };
}

const requiredTags = {
  Project: 'FSK',
  Environment: 'production',
  ManagedBy: 'AmplifyGen2',
  CostCenter: 'FSK',
};

function fakeAwsClients(config = targetConfiguration()): AwsMigrationClients & {
  calls: Array<{ service: string; input: Record<string, unknown> }>;
  dynamoItems: Map<string, Record<string, unknown>>;
  objects: Map<string, { body: Buffer; metadata: Record<string, string> }>;
} {
  const calls: Array<{ service: string; input: Record<string, unknown> }> = [];
  const dynamoItems = new Map<string, Record<string, unknown>>();
  const objects = new Map<string, { body: Buffer; metadata: Record<string, string> }>();
  const send = async (service: string, command: { input?: Record<string, unknown>; constructor?: { name?: string } }) => {
    const input = command.input ?? {};
    calls.push({ service, input });
    const commandName = command.constructor?.name;
    if (service === 'sts') return { Account: config.accountId };
    if (service === 'amplify') {
      return {
        app: {
          appId: config.amplifyApp.appId,
          name: config.amplifyApp.name,
          appArn: `arn:aws:amplify:${config.region}:${config.accountId}:apps/${config.amplifyApp.appId}`,
          tags: requiredTags,
        },
      };
    }
    if (service === 'cloudFormation') {
      if (commandName === 'ListStackResourcesCommand') {
        const stackName = String(input.StackName);
        const resources = [
          ...Object.values(config.tables).map((resource) => ({ ...resource, type: 'AWS::DynamoDB::Table', physicalId: resource.name })),
          { ...config.bucket, type: 'AWS::S3::Bucket', physicalId: config.bucket.name },
          { ...config.userPool, type: 'AWS::Cognito::UserPool', physicalId: config.userPool.id },
        ].filter((resource) => resource.stackName === stackName);
        return {
          StackResourceSummaries: resources.map((resource) => ({
            PhysicalResourceId: resource.physicalId,
            ResourceType: resource.type,
          })),
        };
      }
      const stackName = String(input.StackName);
      const expected = Object.values(config.stacks).find(
        (stack) => stack.name === stackName,
      );
      return { Stacks: [{ StackName: stackName, StackId: expected?.arn, StackStatus: 'CREATE_COMPLETE', Tags: Object.entries(requiredTags).map(([Key, Value]) => ({ Key, Value })) }] };
    }
    if (service === 'dynamo') {
      if (commandName === 'DescribeTableCommand') {
        const table = Object.values(config.tables).find((value) => value.name === input.TableName);
        return { Table: { TableName: table?.name, TableArn: table?.arn, TableStatus: 'ACTIVE' } };
      }
      if (commandName === 'ListTagsOfResourceCommand') {
        return { Tags: Object.entries(requiredTags).map(([Key, Value]) => ({ Key, Value })) };
      }
      if (commandName === 'PutItemCommand') {
        const item = input.Item as Record<string, unknown>;
        const keyName = String((input.ExpressionAttributeNames as Record<string, string>)['#primaryKey']);
        const key = JSON.stringify([input.TableName, item[keyName]]);
        if (dynamoItems.has(key)) {
          const error = new Error('conditional');
          error.name = 'ConditionalCheckFailedException';
          throw error;
        }
        dynamoItems.set(key, item);
        return {};
      }
      if (commandName === 'GetItemCommand') {
        const key = JSON.stringify([
          input.TableName,
          Object.values(input.Key as Record<string, unknown>)[0],
        ]);
        return { Item: dynamoItems.get(key) };
      }
      return {};
    }
    if (service === 's3') {
      if (commandName === 'GetBucketLocationCommand') return { LocationConstraint: config.region };
      if (commandName === 'GetBucketTaggingCommand') return { TagSet: Object.entries(requiredTags).map(([Key, Value]) => ({ Key, Value })) };
      if (commandName === 'HeadObjectCommand') {
        const object = objects.get(String(input.Key));
        if (!object) {
          const error = new Error('missing');
          error.name = 'NotFound';
          throw error;
        }
        return {
          ContentLength: object.body.length,
          Metadata: object.metadata,
        };
      }
      if (commandName === 'PutObjectCommand') {
        const key = String(input.Key);
        if (objects.has(key)) {
          const error = new Error('precondition');
          error.name = 'PreconditionFailed';
          throw error;
        }
        const body = input.Body as AsyncIterable<unknown> | undefined;
        if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
          throw new Error('TEST_UPLOAD_BODY_NOT_ASYNC_ITERABLE');
        }
        const expectedLength = Number(input.ContentLength);
        const bytes = Buffer.alloc(expectedLength);
        let offset = 0;
        for await (const chunk of body) {
          if (!(chunk instanceof Uint8Array) || offset + chunk.byteLength > bytes.length) {
            throw new Error('TEST_UPLOAD_BODY_INVALID');
          }
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        if (offset !== expectedLength) throw new Error('TEST_UPLOAD_BODY_INVALID');
        objects.set(key, {
          body: bytes,
          metadata: input.Metadata as Record<string, string>,
        });
        return {};
      }
      if (commandName === 'GetObjectCommand') {
        const object = objects.get(String(input.Key));
        if (!object) {
          const error = new Error('missing');
          error.name = 'NoSuchKey';
          throw error;
        }
        return { Body: Readable.from([object.body]) };
      }
      return {};
    }
    if (service === 'cognito') {
      if (commandName === 'ListTagsForResourceCommand') return { Tags: requiredTags };
      if (commandName === 'ListGroupsCommand') {
        return { Groups: [{ GroupName: 'OWNER' }, { GroupName: 'KITCHEN' }] };
      }
      return { UserPool: { Id: config.userPool.id, Arn: config.userPool.arn, Name: 'FSK' } };
    }
    return {};
  };
  return {
    calls,
    dynamoItems,
    objects,
    sts: { send: (command) => send('sts', command) },
    amplify: { send: (command) => send('amplify', command) },
    cloudFormation: { send: (command) => send('cloudFormation', command) },
    dynamo: { send: (command) => send('dynamo', command) },
    s3: { send: (command) => send('s3', command) },
    cognito: { send: (command) => send('cognito', command) },
  };
}

describe('AWS target safety and DynamoDB adapter', () => {
  it('rejects wrong account, region, GameList and incomplete explicit resources', () => {
    const base = targetConfiguration();
    for (const invalid of [
      { ...base, accountId: '000000000000' },
      { ...base, region: 'us-east-1' },
      { ...base, amplifyApp: { ...base.amplifyApp, name: 'GameList' } },
      { ...base, tables: { ...base.tables, DailyReport: undefined } },
    ]) {
      expect(() => assertExplicitTargetConfiguration(invalid)).toThrow(
        /TARGET_(ACCOUNT|REGION|GAMELIST|CONFIG)/,
      );
    }
  });

  it('independently verifies app, every stack, table, bucket and user pool before first write', async () => {
    const config = targetConfiguration();
    const clients = fakeAwsClients(config);
    const target = new AwsMigrationTarget(config, clients);
    await target.assertSafeTarget();
    await target.putRecord(
      'ShiftDefinition',
      'shift-day',
      amplifyDataTargetRecord('ShiftDefinition', {
        id: 'shift-day', name: '白班', sortOrder: 10, active: true,
      }),
    );
    const servicesBeforeWrite = clients.calls
      .slice(0, clients.calls.findIndex((call) => 'ConditionExpression' in call.input))
      .map((call) => call.service);
    expect(servicesBeforeWrite).toContain('sts');
    expect(servicesBeforeWrite).toContain('amplify');
    expect(servicesBeforeWrite.filter((value) => value === 'cloudFormation').length).toBeGreaterThanOrEqual(8);
    expect(servicesBeforeWrite.filter((value) => value === 'dynamo').length).toBeGreaterThanOrEqual(8);
    expect(servicesBeforeWrite).toContain('s3');
    expect(servicesBeforeWrite).toContain('cognito');
  });

  it('uses conditional put then strong consistent read for identical no-op and conflicts on changed content', async () => {
    const config = targetConfiguration();
    const clients = fakeAwsClients(config);
    const target = new AwsMigrationTarget(config, clients);
    await target.assertSafeTarget();
    const record = amplifyDataTargetRecord('ShiftDefinition', {
      id: 'shift-day', name: '白班', sortOrder: 10, active: true,
    });
    expect(await target.putRecord('ShiftDefinition', 'shift-day', record)).toBe('created');
    expect(await target.putRecord('ShiftDefinition', 'shift-day', { ...record })).toBe('unchanged');
    await expect(
      target.putRecord('ShiftDefinition', 'shift-day', { ...record, name: '夜班' }),
    ).rejects.toThrow('TARGET_RECORD_CONFLICT:ShiftDefinition:shift-day');
    const puts = clients.calls.filter((call) => 'ConditionExpression' in call.input);
    expect(puts[0].input).toMatchObject({
      ConditionExpression: 'attribute_not_exists(#primaryKey)',
      ExpressionAttributeNames: { '#primaryKey': 'id' },
    });
    const gets = clients.calls.filter((call) => call.input.ConsistentRead === true);
    expect(gets).toHaveLength(2);
  });

  it('fails target preflight on a single mismatched resource tag before any write', async () => {
    const config = targetConfiguration();
    const clients = fakeAwsClients(config);
    const originalSend = clients.dynamo.send.bind(clients.dynamo);
    clients.dynamo.send = async (command) => {
      if (command.constructor?.name === 'ListTagsOfResourceCommand') {
        return {
          Tags: [
            { Key: 'Project', Value: 'GameList' },
            { Key: 'Environment', Value: 'production' },
            { Key: 'ManagedBy', Value: 'AmplifyGen2' },
            { Key: 'CostCenter', Value: 'FSK' },
          ],
        };
      }
      return originalSend(command);
    };
    const target = new AwsMigrationTarget(config, clients);
    await expect(target.assertSafeTarget()).rejects.toThrow(
      'TARGET_TAG_MISMATCH:Table:ShiftDefinition:Project',
    );
    await expect(
      target.putRecord('ShiftDefinition', 'shift-day', {
        id: 'shift-day', name: '白班', sortOrder: 10, active: true,
      }),
    ).rejects.toThrow('TARGET_PREFLIGHT_REQUIRED');
    expect(clients.calls.some((call) => 'ConditionExpression' in call.input)).toBe(false);
  });

  it('rejects any Cognito business-group set other than OWNER and KITCHEN before writes', async () => {
    const config = targetConfiguration();
    const clients = fakeAwsClients(config);
    const originalSend = clients.cognito.send.bind(clients.cognito);
    clients.cognito.send = async (command) => {
      if (command.constructor?.name === 'ListGroupsCommand') {
        return { Groups: [{ GroupName: 'OWNER' }, { GroupName: 'ADMIN' }] };
      }
      return originalSend(command);
    };
    const target = new AwsMigrationTarget(config, clients);
    await expect(target.assertSafeTarget()).rejects.toThrow(
      'TARGET_COGNITO_GROUPS_MISMATCH',
    );
    expect(clients.calls.some((call) => 'ConditionExpression' in call.input)).toBe(false);
  });

  it.each([
    'UPDATE_IN_PROGRESS',
    'UPDATE_ROLLBACK_COMPLETE',
    'DELETE_COMPLETE',
    'SYNTHETIC_UNKNOWN',
  ])('rejects non-active CloudFormation stack status %s before writes', async (status) => {
    const config = targetConfiguration();
    const clients = fakeAwsClients(config);
    const originalSend = clients.cloudFormation.send.bind(clients.cloudFormation);
    clients.cloudFormation.send = async (command) => {
      const result = await originalSend(command) as {
        Stacks?: Array<Record<string, unknown>>;
      };
      if (command.constructor?.name === 'DescribeStacksCommand') {
        return {
          ...result,
          Stacks: result.Stacks?.map((stack) => ({
            ...stack,
            StackStatus: status,
          })),
        };
      }
      return result;
    };
    const target = new AwsMigrationTarget(config, clients);
    await expect(target.assertSafeTarget()).rejects.toThrow(
      'TARGET_STACK_STATUS_INVALID',
    );
    expect(
      clients.calls.some(
        (call) =>
          'ConditionExpression' in call.input || 'IfNoneMatch' in call.input,
      ),
    ).toBe(false);
  });

  it.each(['CREATING', 'UPDATING', 'DELETING', 'SYNTHETIC_UNKNOWN'])(
    'rejects non-ACTIVE DynamoDB table status %s before writes',
    async (status) => {
      const config = targetConfiguration();
      const clients = fakeAwsClients(config);
      const originalSend = clients.dynamo.send.bind(clients.dynamo);
      clients.dynamo.send = async (command) => {
        const result = await originalSend(command) as {
          Table?: Record<string, unknown>;
        };
        if (command.constructor?.name === 'DescribeTableCommand') {
          return {
            ...result,
            Table: { ...result.Table, TableStatus: status },
          };
        }
        return result;
      };
      const target = new AwsMigrationTarget(config, clients);
      await expect(target.assertSafeTarget()).rejects.toThrow(
        'TARGET_TABLE_STATUS_INVALID',
      );
      expect(
        clients.calls.some(
          (call) =>
            'ConditionExpression' in call.input || 'IfNoneMatch' in call.input,
        ),
      ).toBe(false);
    },
  );
});

describe('attachment import and independent verification', () => {
  it('rejects a direct over-5-GiB attachment before preflight or any AWS call', async () => {
    const root = temporaryRoot();
    const bundle = fixtureBundle();
    addAttachment(bundle, root);
    const entry = {
      ...bundle.attachments[0],
      byteSize: S3_SINGLE_PUT_MAX_BYTES + 1,
    };
    const clients = fakeAwsClients();
    const target = new AwsMigrationTarget(targetConfiguration(), clients);
    await expect(
      target.putAttachment(
        entry,
        join(root, entry.sourceRelativeKey),
        root,
      ),
    ).rejects.toThrow('TARGET_ATTACHMENT_EXCEEDS_CONDITIONAL_PUT_LIMIT');
    expect(clients.calls).toEqual([]);
  });

  it('streams a 64-MiB sparse source from the held fd with chunks bounded to 1 MiB', async () => {
    const root = temporaryRoot();
    const relativeKey = 'large-report/large.bin';
    const sourcePath = join(root, relativeKey);
    mkdirSync(join(root, 'large-report'));
    writeFileSync(sourcePath, '');
    const byteSize = 64 * 1024 * 1024;
    truncateSync(sourcePath, byteSize);
    const digest = zeroFileSha256(byteSize);
    const entry = {
      sourceRelativeKey: relativeKey,
      objectKey: `migration/daily-reports/2026-08-24#shift-day/${digest}-large.bin`,
      byteSize,
      sha256: digest,
      reportKey: '2026-08-24#shift-day',
    };
    const clients = fakeAwsClients();
    const target = new AwsMigrationTarget(targetConfiguration(), clients);
    await target.assertSafeTarget();
    let uploaded = false;
    let uploadedBytes = 0;
    let maxChunkBytes = 0;
    const uploadHash = createHash('sha256');
    clients.s3.send = async (command) => {
      const name = command.constructor?.name;
      if (name === 'HeadObjectCommand') {
        if (!uploaded) {
          const error = new Error('missing');
          error.name = 'NotFound';
          throw error;
        }
        return {
          ContentLength: byteSize,
          Metadata: { sha256: digest, 'byte-size': String(byteSize) },
        };
      }
      if (name === 'PutObjectCommand') {
        const body = command.input?.Body as AsyncIterable<unknown> | undefined;
        if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
          throw new Error('TEST_UPLOAD_BODY_NOT_ASYNC_ITERABLE');
        }
        for await (const chunk of body) {
          if (!(chunk instanceof Uint8Array)) {
            throw new Error('TEST_UPLOAD_CHUNK_INVALID');
          }
          maxChunkBytes = Math.max(maxChunkBytes, chunk.byteLength);
          uploadedBytes += chunk.byteLength;
          uploadHash.update(chunk);
        }
        uploaded = true;
        return {};
      }
      throw new Error(`TEST_UNEXPECTED_S3_COMMAND:${name}`);
    };
    await expect(
      target.putAttachment(entry, sourcePath, root),
    ).resolves.toBe('created');
    expect(uploadedBytes).toBe(byteSize);
    expect(maxChunkBytes).toBeLessThanOrEqual(STREAM_CHUNK_BYTES);
    expect(uploadHash.digest('hex')).toBe(digest);
  });

  it('streams GetObject verification without Buffer.concat or transformToByteArray', async () => {
    const byteSize = 64 * 1024 * 1024;
    const digest = zeroFileSha256(byteSize);
    const clients = fakeAwsClients();
    const target = new AwsMigrationTarget(targetConfiguration(), clients);
    await target.assertSafeTarget();
    const chunk = Buffer.alloc(STREAM_CHUNK_BYTES);
    clients.s3.send = async (command) => {
      if (command.constructor?.name === 'HeadObjectCommand') {
        return {
          ContentLength: byteSize,
          Metadata: { sha256: digest, 'byte-size': String(byteSize) },
        };
      }
      if (command.constructor?.name === 'GetObjectCommand') {
        return {
          Body: Readable.from(
            Array.from({ length: byteSize / chunk.length }, () => chunk),
          ),
        };
      }
      throw new Error('TEST_UNEXPECTED_S3_COMMAND');
    };
    const concat = vi.spyOn(Buffer, 'concat').mockImplementation(() => {
      throw new Error('TEST_FULL_BUFFER_CONCAT_FORBIDDEN');
    });
    try {
      await expect(
        target.readAttachment('migration/daily-reports/large/large.bin'),
      ).resolves.toEqual({ byteSize, sha256: digest });
    } finally {
      concat.mockRestore();
    }
  });

  it('rejects a transformToByteArray-only GetObject body as non-streaming', async () => {
    const clients = fakeAwsClients();
    const target = new AwsMigrationTarget(targetConfiguration(), clients);
    await target.assertSafeTarget();
    clients.s3.send = async (command) => {
      if (command.constructor?.name === 'HeadObjectCommand') {
        return {
          ContentLength: 1,
          Metadata: { sha256: sha256('x'), 'byte-size': '1' },
        };
      }
      if (command.constructor?.name === 'GetObjectCommand') {
        return {
          Body: { async transformToByteArray() { return Buffer.from('x'); } },
        };
      }
      throw new Error('TEST_UNEXPECTED_S3_COMMAND');
    };
    await expect(
      target.readAttachment('migration/daily-reports/report/x.txt'),
    ).rejects.toThrow('TARGET_ATTACHMENT_BODY_INVALID');
  });

  it('rejects a streaming GetObject body that contains bytes beyond HeadObject size', async () => {
    const clients = fakeAwsClients();
    const target = new AwsMigrationTarget(targetConfiguration(), clients);
    await target.assertSafeTarget();
    clients.s3.send = async (command) => {
      if (command.constructor?.name === 'HeadObjectCommand') {
        return {
          ContentLength: 1,
          Metadata: { sha256: sha256('x'), 'byte-size': '1' },
        };
      }
      if (command.constructor?.name === 'GetObjectCommand') {
        return { Body: Readable.from([Buffer.from('xy')]) };
      }
      throw new Error('TEST_UNEXPECTED_S3_COMMAND');
    };
    await expect(
      target.readAttachment('migration/daily-reports/report/x.txt'),
    ).rejects.toThrow('TARGET_ATTACHMENT_BODY_SIZE_MISMATCH');
  });

  it('rejects malformed non-binary chunks from a streaming GetObject body', async () => {
    const clients = fakeAwsClients();
    const target = new AwsMigrationTarget(targetConfiguration(), clients);
    await target.assertSafeTarget();
    clients.s3.send = async (command) => {
      if (command.constructor?.name === 'HeadObjectCommand') {
        return {
          ContentLength: 1,
          Metadata: { sha256: sha256('x'), 'byte-size': '1' },
        };
      }
      if (command.constructor?.name === 'GetObjectCommand') {
        return { Body: Readable.from([{ not: 'binary' }]) };
      }
      throw new Error('TEST_UNEXPECTED_S3_COMMAND');
    };
    await expect(
      target.readAttachment('migration/daily-reports/report/x.txt'),
    ).rejects.toThrow('TARGET_ATTACHMENT_BODY_INVALID');
  });

  it('recovers a non-replayable PutObject exception only after independent exact Head and Get reads', async () => {
    const root = temporaryRoot();
    const bundle = fixtureBundle();
    addAttachment(bundle, root);
    const entry = bundle.attachments[0];
    const clients = fakeAwsClients();
    const originalSend = clients.s3.send.bind(clients.s3);
    let headReads = 0;
    let getReads = 0;
    clients.s3.send = async (command) => {
      if (command.constructor?.name === 'HeadObjectCommand') headReads += 1;
      if (command.constructor?.name === 'GetObjectCommand') getReads += 1;
      if (command.constructor?.name === 'PutObjectCommand') {
        await originalSend(command);
        const error = new Error('synthetic unknown response');
        error.name = 'SyntheticTransportFailure';
        throw error;
      }
      return originalSend(command);
    };
    const target = new AwsMigrationTarget(targetConfiguration(), clients);
    await target.assertSafeTarget();
    await expect(
      target.putAttachment(
        entry,
        join(root, entry.sourceRelativeKey),
        root,
      ),
    ).resolves.toBe('unchanged');
    expect(
      clients.calls.filter((call) => 'IfNoneMatch' in call.input),
    ).toHaveLength(1);
    expect(headReads).toBe(3);
    expect(getReads).toBe(1);
  });

  it('preserves an unknown PutObject outcome when independent reads cannot prove exact content', async () => {
    const root = temporaryRoot();
    const bundle = fixtureBundle();
    addAttachment(bundle, root);
    const entry = bundle.attachments[0];
    const clients = fakeAwsClients();
    const originalSend = clients.s3.send.bind(clients.s3);
    clients.s3.send = async (command) => {
      if (command.constructor?.name === 'PutObjectCommand') {
        const error = new Error('synthetic unknown response');
        error.name = 'SyntheticTransportFailure';
        throw error;
      }
      return originalSend(command);
    };
    const target = new AwsMigrationTarget(targetConfiguration(), clients);
    await target.assertSafeTarget();
    await expect(
      target.putAttachment(
        entry,
        join(root, entry.sourceRelativeKey),
        root,
      ),
    ).rejects.toThrow(`TARGET_ATTACHMENT_PUT_OUTCOME_UNKNOWN:${entry.objectKey}`);
  });

  it('accepts exact expected keys across small S3 inventory pages', async () => {
    const clients = fakeAwsClients();
    const originalSend = clients.s3.send.bind(clients.s3);
    clients.s3.send = async (command) => {
      if (command.constructor?.name === 'ListObjectsV2Command') {
        clients.calls.push({ service: 's3', input: command.input ?? {} });
        if (command.input?.ContinuationToken === undefined) {
          return {
            Contents: [{ Key: 'migration/daily-reports/report-a/a.txt' }],
            IsTruncated: true,
            NextContinuationToken: 'page-2',
          };
        }
        return {
          Contents: [{ Key: 'migration/daily-reports/report-b/b.txt' }],
          IsTruncated: false,
        };
      }
      return originalSend(command);
    };
    const target = new AwsMigrationTarget(targetConfiguration(), clients);
    await target.assertSafeTarget();
    await expect(
      (target as unknown as {
        assertAttachmentObjectKeys(expected: ReadonlySet<string>): Promise<void>;
      }).assertAttachmentObjectKeys(new Set([
        'migration/daily-reports/report-a/a.txt',
        'migration/daily-reports/report-b/b.txt',
      ])),
    ).resolves.toBeUndefined();
    const listCalls = clients.calls.filter(
      (call) => call.input.Prefix === 'migration/daily-reports/',
    );
    expect(listCalls).toHaveLength(2);
  });

  it('rejects duplicate S3 keys and a continuation-token cycle', async () => {
    for (const mode of ['duplicate', 'cycle'] as const) {
      const clients = fakeAwsClients();
      const originalSend = clients.s3.send.bind(clients.s3);
      clients.s3.send = async (command) => {
        if (command.constructor?.name !== 'ListObjectsV2Command') {
          return originalSend(command);
        }
        const token = command.input?.ContinuationToken;
        if (token === undefined) {
          return {
            Contents: [{ Key: 'migration/daily-reports/report-a/a.txt' }],
            IsTruncated: true,
            NextContinuationToken: 'page-2',
          };
        }
        return mode === 'duplicate'
          ? {
              Contents: [{ Key: 'migration/daily-reports/report-a/a.txt' }],
              IsTruncated: false,
            }
          : {
              Contents: [{ Key: 'migration/daily-reports/report-b/b.txt' }],
              IsTruncated: true,
              NextContinuationToken: 'page-2',
            };
      };
      const target = new AwsMigrationTarget(targetConfiguration(), clients);
      await target.assertSafeTarget();
      await expect(
        (target as unknown as {
          assertAttachmentObjectKeys(expected: ReadonlySet<string>): Promise<void>;
        }).assertAttachmentObjectKeys(new Set([
          'migration/daily-reports/report-a/a.txt',
          'migration/daily-reports/report-b/b.txt',
        ])),
      ).rejects.toThrow(
        mode === 'duplicate'
          ? 'TARGET_ATTACHMENT_LIST_DUPLICATE'
          : 'TARGET_ATTACHMENT_LIST_PAGINATION_CYCLE',
      );
    }
  });

  it('rejects malformed or out-of-prefix S3 inventory pages', async () => {
    for (const page of [
      { Contents: [{}], IsTruncated: false },
      {
        Contents: [{ Key: 'unexpected-prefix/report-a/a.txt' }],
        IsTruncated: false,
      },
      {
        Contents: [],
        IsTruncated: true,
      },
      {
        Contents: [],
        IsTruncated: false,
        NextContinuationToken: 'unexpected-token',
      },
    ]) {
      const clients = fakeAwsClients();
      const originalSend = clients.s3.send.bind(clients.s3);
      clients.s3.send = async (command) =>
        command.constructor?.name === 'ListObjectsV2Command'
          ? page
          : originalSend(command);
      const target = new AwsMigrationTarget(targetConfiguration(), clients);
      await target.assertSafeTarget();
      await expect(
        (target as unknown as {
          assertAttachmentObjectKeys(expected: ReadonlySet<string>): Promise<void>;
        }).assertAttachmentObjectKeys(new Set()),
      ).rejects.toThrow('TARGET_ATTACHMENT_LIST_INVALID');
    }
  });

  it('stops on an unexpected key in the first S3 page without reading polluted later pages', async () => {
    const clients = fakeAwsClients();
    const originalSend = clients.s3.send.bind(clients.s3);
    let listCalls = 0;
    clients.s3.send = async (command) => {
      if (command.constructor?.name !== 'ListObjectsV2Command') {
        return originalSend(command);
      }
      listCalls += 1;
      return {
        Contents: [
          { Key: 'migration/daily-reports/unexpected/polluted.txt' },
        ],
        IsTruncated: true,
        NextContinuationToken: 'must-not-be-read',
      };
    };
    const target = new AwsMigrationTarget(targetConfiguration(), clients);
    await target.assertSafeTarget();
    await expect(
      (target as unknown as {
        assertAttachmentObjectKeys(expected: ReadonlySet<string>): Promise<void>;
      }).assertAttachmentObjectKeys(new Set([
        'migration/daily-reports/report-a/a.txt',
      ])),
    ).rejects.toThrow('TARGET_ATTACHMENT_LIST_UNEXPECTED');
    expect(listCalls).toBe(1);
  });

  it('rejects a truncated S3 page that makes no expected-key progress', async () => {
    const clients = fakeAwsClients();
    const originalSend = clients.s3.send.bind(clients.s3);
    clients.s3.send = async (command) =>
      command.constructor?.name === 'ListObjectsV2Command'
        ? {
            Contents: [],
            IsTruncated: true,
            NextContinuationToken: 'empty-page',
          }
        : originalSend(command);
    const target = new AwsMigrationTarget(targetConfiguration(), clients);
    await target.assertSafeTarget();
    await expect(
      target.assertAttachmentObjectKeys(new Set([
        'migration/daily-reports/report-a/a.txt',
      ])),
    ).rejects.toThrow('TARGET_ATTACHMENT_LIST_PAGINATION_NO_PROGRESS');
  });

  it('independent verification rejects an extra object under the migration prefix', async () => {
    const root = temporaryRoot();
    const bundle = fixtureBundle();
    addAttachment(bundle, root);
    const target = new MemoryTarget();
    await importMigrationBundle({
      mode: 'apply',
      approvalId: 'FSK-TASK11-SYNTHETIC-EXTRA-OBJECT',
      bundle,
      uploadsRoot: root,
      target,
      checkpointStore: new MemoryCheckpointStore(),
    });
    target.attachments.set(
      'migration/daily-reports/unexpected/extra.txt',
      { byteSize: 5, sha256: sha256('extra') },
    );
    await expect(verifyMigrationTarget({ bundle, target })).rejects.toThrow(
      'TARGET_VERIFICATION_MISMATCH:attachmentKeys',
    );
  });

  it('independent verification rejects a missing expected object', async () => {
    const root = temporaryRoot();
    const bundle = fixtureBundle();
    addAttachment(bundle, root);
    const target = new MemoryTarget();
    await importMigrationBundle({
      mode: 'apply',
      approvalId: 'FSK-TASK11-SYNTHETIC-MISSING-OBJECT',
      bundle,
      uploadsRoot: root,
      target,
      checkpointStore: new MemoryCheckpointStore(),
    });
    target.attachments.delete(bundle.attachments[0].objectKey);
    await expect(verifyMigrationTarget({ bundle, target })).rejects.toThrow(
      'TARGET_VERIFICATION_MISMATCH:attachmentKeys',
    );
  });

  it('reads only the explicit source path, validates pre/post hash, and verifies HeadObject metadata', async () => {
    const root = temporaryRoot();
    const bundle = fixtureBundle();
    addAttachment(bundle, root);
    const entry = bundle.attachments[0];
    const target = new MemoryTarget();
    expect(await target.putAttachment(entry, join(root, entry.sourceRelativeKey), root)).toBe('created');
    expect(await target.putAttachment(entry, join(root, entry.sourceRelativeKey), root)).toBe('unchanged');
    expect(basename(entry.objectKey)).toBe(`${entry.sha256}-receipt.txt`);
  });

  it('rejects an attachment reached through an intermediate symlink outside the canonical uploads root', async () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    const bundle = fixtureBundle();
    addAttachment(bundle, root);
    const entry = bundle.attachments[0];
    rmSync(join(root, 'legacy-report-1'), { recursive: true });
    mkdirSync(join(outside, 'legacy-report-1'));
    writeFileSync(
      join(outside, entry.sourceRelativeKey),
      'receipt-one',
    );
    symlinkSync(
      join(outside, 'legacy-report-1'),
      join(root, 'legacy-report-1'),
      'dir',
    );
    const target = new AwsMigrationTarget(
      targetConfiguration(),
      fakeAwsClients(),
    );
    await target.assertSafeTarget();
    await expect(
      (target.putAttachment as unknown as (
        attachment: typeof entry,
        sourcePath: string,
        uploadsRoot: string,
      ) => Promise<unknown>)(
        entry,
        join(root, entry.sourceRelativeKey),
        root,
      ),
    ).rejects.toThrow('TARGET_ATTACHMENT_SOURCE_INVALID');
  });

  it('uses one conditional S3 key, verifies metadata, and repeats as HeadObject no-op', async () => {
    const root = temporaryRoot();
    const bundle = fixtureBundle();
    addAttachment(bundle, root);
    const entry = bundle.attachments[0];
    const clients = fakeAwsClients();
    const target = new AwsMigrationTarget(targetConfiguration(), clients);
    await target.assertSafeTarget();
    const sourcePath = join(root, entry.sourceRelativeKey);
    expect(await target.putAttachment(entry, sourcePath, root)).toBe('created');
    expect(await target.putAttachment(entry, sourcePath, root)).toBe('unchanged');
    const puts = clients.calls.filter(
      (call) => 'IfNoneMatch' in call.input,
    );
    expect(puts).toHaveLength(1);
    expect(puts[0].input).toMatchObject({
      Bucket: targetConfiguration().bucket.name,
      Key: entry.objectKey,
      IfNoneMatch: '*',
      ContentLength: entry.byteSize,
      Metadata: { sha256: entry.sha256, 'byte-size': String(entry.byteSize) },
    });
    expect(clients.objects.get(entry.objectKey)?.body.toString()).toBe('receipt-one');
    expect(await target.readAttachment(entry.objectKey)).toEqual({
      byteSize: entry.byteSize,
      sha256: entry.sha256,
    });
  });

  it('fails closed if the explicit source file changes while S3 upload is in flight', async () => {
    const root = temporaryRoot();
    const bundle = fixtureBundle();
    addAttachment(bundle, root);
    const entry = bundle.attachments[0];
    const sourcePath = join(root, entry.sourceRelativeKey);
    const clients = fakeAwsClients();
    const originalSend = clients.s3.send.bind(clients.s3);
    clients.s3.send = async (command) => {
      const result = await originalSend(command);
      if (command.constructor?.name === 'PutObjectCommand') {
        writeFileSync(sourcePath, 'changed-after-upload');
      }
      return result;
    };
    const target = new AwsMigrationTarget(targetConfiguration(), clients);
    await target.assertSafeTarget();
    await expect(target.putAttachment(entry, sourcePath, root)).rejects.toThrow(
      `TARGET_ATTACHMENT_SOURCE_CHANGED:${entry.objectKey}`,
    );
  });

  it.each(['directory', 'file'] as const)(
    'fails closed if the source %s is replaced while S3 upload is in flight',
    async (replacement) => {
      const root = temporaryRoot();
      const bundle = fixtureBundle();
      addAttachment(bundle, root);
      const entry = bundle.attachments[0];
      const sourcePath = join(root, entry.sourceRelativeKey);
      const sourceDirectory = join(root, 'legacy-report-1');
      const clients = fakeAwsClients();
      const originalSend = clients.s3.send.bind(clients.s3);
      clients.s3.send = async (command) => {
        const result = await originalSend(command);
        if (command.constructor?.name === 'PutObjectCommand') {
          if (replacement === 'directory') {
            renameSync(sourceDirectory, join(root, 'replaced-directory'));
            mkdirSync(sourceDirectory);
          } else {
            renameSync(sourcePath, `${sourcePath}.replaced`);
          }
          writeFileSync(sourcePath, 'receipt-one');
        }
        return result;
      };
      const target = new AwsMigrationTarget(targetConfiguration(), clients);
      await target.assertSafeTarget();
      await expect(
        target.putAttachment(entry, sourcePath, root),
      ).rejects.toThrow(
        `TARGET_ATTACHMENT_SOURCE_CHANGED:${entry.objectKey}`,
      );
    },
  );

  it('re-reads target records and objects and recomputes all raw, five derived, and two meal totals', async () => {
    const root = temporaryRoot();
    const bundle = fixtureBundle();
    addAttachment(bundle, root);
    const target = new MemoryTarget();
    await importMigrationBundle({
      mode: 'apply',
      approvalId: 'FSK-TASK11-SYNTHETIC-VERIFY',
      bundle,
      uploadsRoot: root,
      target,
      checkpointStore: new MemoryCheckpointStore(),
    });
    const result = await verifyMigrationTarget({ bundle, target });
    expect(result).toEqual({
      status: 'verified',
      modelCounts: bundle.sourceSummary.modelCounts,
      amounts: bundle.sourceSummary.amounts,
      attachments: bundle.sourceSummary.targetAttachmentSummary,
    });

    const changed = target.records.get('DailyReport:2026-08-24#shift-day') as Record<string, unknown>;
    changed.staffMealCashYen = 999;
    await expect(verifyMigrationTarget({ bundle, target })).rejects.toThrow(
      'TARGET_VERIFICATION_MISMATCH:amounts',
    );
  });
});
