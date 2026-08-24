import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MAX_YEN,
  assertDailyReportRawAmounts,
  dailyReportKey,
} from '@fsk/domain';
import type { MigrationBundle } from './contracts';
import { buildMigrationSummary } from './report';
import {
  TARGET_MODEL_ORDER,
  S3_CONDITIONAL_PUT_MAX_BYTES,
  amplifyDataTargetRecord,
  assertExplicitTargetConfiguration,
  createAwsMigrationTarget,
  targetConfigurationFingerprint,
  type MigrationModelName,
  type MigrationTarget,
  type TargetConfiguration,
} from './target';

export type ImportStage = MigrationModelName | 'Attachment';

export interface ImportCheckpoint {
  version: 1;
  bundleSha256: string;
  targetFingerprint: string;
  status: 'in-progress' | 'failed' | 'complete';
  completedStages: ImportStage[];
  failedStage?: ImportStage;
  failureCode?: string;
}

interface CheckpointStore {
  load(): Promise<ImportCheckpoint | null>;
  saveAtomic(checkpoint: ImportCheckpoint): Promise<void>;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableValue(record[key])]),
    );
  }
  return value;
}

function serializeCheckpoint(checkpoint: ImportCheckpoint): string {
  const value = `${JSON.stringify(stableValue(checkpoint), null, 2)}\n`;
  if (/password|secret|token|credential/i.test(value)) {
    throw new Error('IMPORT_CHECKPOINT_FORBIDDEN_FIELD');
  }
  return value;
}

function validateCheckpoint(value: unknown): ImportCheckpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('IMPORT_CHECKPOINT_INVALID');
  }
  const checkpoint = value as Partial<ImportCheckpoint>;
  const orderedStages: ImportStage[] = [...TARGET_MODEL_ORDER, 'Attachment'];
  const exactKeys = [
    'version',
    'bundleSha256',
    'targetFingerprint',
    'status',
    'completedStages',
    ...(checkpoint.status === 'failed' ? ['failedStage', 'failureCode'] : []),
  ].sort();
  if (
    Object.keys(value).sort().join(',') !== exactKeys.join(',') ||
    checkpoint.version !== 1 ||
    typeof checkpoint.bundleSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(checkpoint.bundleSha256) ||
    typeof checkpoint.targetFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(checkpoint.targetFingerprint) ||
    !['in-progress', 'failed', 'complete'].includes(String(checkpoint.status)) ||
    !Array.isArray(checkpoint.completedStages) ||
    checkpoint.completedStages.some(
      (stage, index) => stage !== orderedStages[index],
    ) ||
    (checkpoint.status === 'complete' &&
      checkpoint.completedStages.length !== orderedStages.length) ||
    (checkpoint.status === 'failed' &&
      (checkpoint.failedStage !== orderedStages[checkpoint.completedStages.length] ||
        typeof checkpoint.failureCode !== 'string' ||
        checkpoint.failureCode.length === 0)) ||
    (checkpoint.status === 'in-progress' &&
      checkpoint.completedStages.length > orderedStages.length)
  ) {
    throw new Error('IMPORT_CHECKPOINT_INVALID');
  }
  return checkpoint as ImportCheckpoint;
}

export class FileCheckpointStore implements CheckpointStore {
  readonly path: string;

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error('IMPORT_CHECKPOINT_PATH_NOT_ABSOLUTE');
    const declaredParent = dirname(path);
    const parentStat = lstatSync(declaredParent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error('IMPORT_CHECKPOINT_PARENT_INVALID');
    }
    this.path = resolve(realpathSync(declaredParent), basename(path));
  }

  async load(): Promise<ImportCheckpoint | null> {
    if (!existsSync(this.path)) return null;
    const stat = lstatSync(this.path);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(this.path) !== this.path) {
      throw new Error('IMPORT_CHECKPOINT_PATH_INVALID');
    }
    const fd = openSync(this.path, 'r');
    try {
      const chunks: Buffer[] = [];
      const chunk = Buffer.alloc(64 * 1024);
      let bytesRead: number;
      while ((bytesRead = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      }
      return validateCheckpoint(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } finally {
      closeSync(fd);
    }
  }

  async saveAtomic(checkpoint: ImportCheckpoint): Promise<void> {
    validateCheckpoint(checkpoint);
    const parent = dirname(this.path);
    const parentStat = lstatSync(parent, { bigint: true });
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error('IMPORT_CHECKPOINT_PARENT_INVALID');
    }
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(fd, serializeCheckpoint(checkpoint));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const beforeRename = lstatSync(parent, { bigint: true });
    if (
      beforeRename.dev !== parentStat.dev ||
      beforeRename.ino !== parentStat.ino ||
      realpathSync(parent) !== parent
    ) {
      unlinkSync(temporary);
      throw new Error('IMPORT_CHECKPOINT_PARENT_CHANGED');
    }
    renameSync(temporary, this.path);
    const parentFd = openSync(parent, 'r');
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  }
}

export interface ImportCliOptions {
  mode: 'dry-run' | 'apply';
  approvalId?: string;
  bundlePath?: string;
  uploadsRoot?: string;
  checkpointPath?: string;
  targetConfigPath?: string;
}

function argumentValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`IMPORT_ARGUMENT_VALUE_REQUIRED:${flag}`);
  return value;
}

export function parseImportCliOptions(argv: string[]): ImportCliOptions {
  const valued = new Set([
    '--approval-id',
    '--bundle',
    '--uploads-root',
    '--checkpoint',
    '--target-config',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valued.has(argument)) {
      index += 1;
      if (index >= argv.length) throw new Error(`IMPORT_ARGUMENT_VALUE_REQUIRED:${argument}`);
    } else if (!['--apply', '--dry-run'].includes(argument)) {
      throw new Error(`IMPORT_ARGUMENT_UNKNOWN:${argument}`);
    }
  }
  const apply = argv.includes('--apply');
  if (apply && argv.includes('--dry-run')) throw new Error('IMPORT_MODE_CONFLICT');
  const approvalId = argumentValue(argv, '--approval-id')?.trim();
  const targetConfigPath = argumentValue(argv, '--target-config');
  if (apply && !approvalId) throw new Error('IMPORT_APPROVAL_ID_REQUIRED');
  if (apply && !targetConfigPath) throw new Error('IMPORT_TARGET_CONFIG_REQUIRED');
  return {
    mode: apply ? 'apply' : 'dry-run',
    approvalId,
    bundlePath: argumentValue(argv, '--bundle'),
    uploadsRoot: argumentValue(argv, '--uploads-root'),
    checkpointPath: argumentValue(argv, '--checkpoint'),
    targetConfigPath,
  };
}

function bundleHash(bundle: MigrationBundle): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(bundle)))
    .digest('hex');
}

function assertExactRecordKeys(
  model: string,
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  const requiredPresent = required.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
  if (
    !requiredPresent ||
    actual.some((key) => !allowed.includes(key))
  ) {
    throw new Error(`IMPORT_BUNDLE_RECORD_UNKNOWN_FIELD:${model}`);
  }
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function validDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function assertBundleRecordContract(bundle: MigrationBundle): void {
  assertExactRecordKeys(
    'MigrationBundle',
    bundle as unknown as Record<string, unknown>,
    [
      'shifts',
      'responsiblePersons',
      'appSetting',
      'dailyReports',
      'attachments',
      'sourceSummary',
    ],
  );
  if (
    !Array.isArray(bundle.shifts) ||
    !Array.isArray(bundle.responsiblePersons) ||
    !Array.isArray(bundle.dailyReports) ||
    !Array.isArray(bundle.attachments) ||
    bundle.sourceSummary.conflicts.length > 0
  ) {
    throw new Error('IMPORT_BUNDLE_RECORD_INVALID:MigrationBundle');
  }
  const shiftIds = new Set<string>();
  for (const shift of bundle.shifts) {
    assertExactRecordKeys('ShiftDefinition', shift as unknown as Record<string, unknown>, [
      'id',
      'name',
      'sortOrder',
      'active',
    ]);
    if (
      !nonblank(shift.id) ||
      !nonblank(shift.name) ||
      !Number.isSafeInteger(shift.sortOrder) ||
      shift.sortOrder < 0 ||
      typeof shift.active !== 'boolean' ||
      shiftIds.has(shift.id)
    ) {
      throw new Error('IMPORT_BUNDLE_RECORD_INVALID:ShiftDefinition');
    }
    shiftIds.add(shift.id);
  }
  const personIds = new Set<string>();
  for (const person of bundle.responsiblePersons) {
    assertExactRecordKeys(
      'ResponsiblePerson',
      person as unknown as Record<string, unknown>,
      ['id', 'name', 'active'],
    );
    if (
      !nonblank(person.id) ||
      !nonblank(person.name) ||
      typeof person.active !== 'boolean' ||
      personIds.has(person.id)
    ) {
      throw new Error('IMPORT_BUNDLE_RECORD_INVALID:ResponsiblePerson');
    }
    personIds.add(person.id);
  }
  assertExactRecordKeys(
    'AppSetting',
    bundle.appSetting as unknown as Record<string, unknown>,
    ['id', 'registerFloatAmount', 'setupCompleted'],
  );
  if (
    bundle.appSetting.id !== 'default' ||
    !Number.isSafeInteger(bundle.appSetting.registerFloatAmount) ||
    bundle.appSetting.registerFloatAmount < 0 ||
    bundle.appSetting.registerFloatAmount > MAX_YEN ||
    typeof bundle.appSetting.setupCompleted !== 'boolean'
  ) {
    throw new Error('IMPORT_BUNDLE_RECORD_INVALID:AppSetting');
  }

  const dailyRequired = [
    'reportKey',
    'businessDate',
    'shiftId',
    'shiftNameSnapshot',
    'responsiblePersonId',
    'responsiblePersonSnapshot',
    'startMinuteOfDay',
    'endMinuteOfDay',
    'timeRangeLabelSnapshot',
    'previousImosBalanceYen',
    'currentImosBalanceYen',
    'newageYen',
    'cashTotalYen',
    'expenseYen',
    'expenseReason',
    'staffMealCashYen',
    'staffMealAlipayYen',
    'attachmentKeys',
    'submittedAt',
  ] as const;
  for (const report of bundle.dailyReports) {
    assertExactRecordKeys(
      'DailyReport',
      report as unknown as Record<string, unknown>,
      dailyRequired,
      ['legacySubmittedByUsername'],
    );
    const raw = {
      previousImosBalanceYen: report.previousImosBalanceYen,
      currentImosBalanceYen: report.currentImosBalanceYen,
      newageYen: report.newageYen,
      cashTotalYen: report.cashTotalYen,
      expenseYen: report.expenseYen,
      staffMealCashYen: report.staffMealCashYen,
      staffMealAlipayYen: report.staffMealAlipayYen,
    };
    try {
      assertDailyReportRawAmounts(raw);
      if (report.reportKey !== dailyReportKey(report.businessDate, report.shiftId)) {
        throw new Error('key');
      }
    } catch {
      throw new Error('IMPORT_BUNDLE_RECORD_INVALID:DailyReport');
    }
    if (
      !shiftIds.has(report.shiftId) ||
      !personIds.has(report.responsiblePersonId) ||
      !nonblank(report.shiftNameSnapshot) ||
      !nonblank(report.responsiblePersonSnapshot) ||
      !nonblank(report.timeRangeLabelSnapshot) ||
      !Number.isInteger(report.startMinuteOfDay) ||
      report.startMinuteOfDay < 0 ||
      report.startMinuteOfDay > 1439 ||
      !Number.isInteger(report.endMinuteOfDay) ||
      report.endMinuteOfDay < 0 ||
      report.endMinuteOfDay > 1439 ||
      report.startMinuteOfDay === report.endMinuteOfDay ||
      (report.expenseYen > 0 && !nonblank(report.expenseReason)) ||
      (report.expenseReason !== null && !nonblank(report.expenseReason)) ||
      !Array.isArray(report.attachmentKeys) ||
      report.attachmentKeys.some((key) => !nonblank(key)) ||
      !validDateTime(report.submittedAt) ||
      (report.legacySubmittedByUsername !== undefined &&
        !nonblank(report.legacySubmittedByUsername))
    ) {
      throw new Error('IMPORT_BUNDLE_RECORD_INVALID:DailyReport');
    }
  }
  for (const attachment of bundle.attachments) {
    assertExactRecordKeys(
      'Attachment',
      attachment as unknown as Record<string, unknown>,
      ['sourceRelativeKey', 'objectKey', 'byteSize', 'sha256', 'reportKey'],
    );
  }
}

function assertLinkedAttachmentBundleContract(bundle: MigrationBundle): void {
  const reportKeys = new Set(bundle.dailyReports.map((report) => report.reportKey));
  if (reportKeys.size !== bundle.dailyReports.length) {
    throw new Error('IMPORT_ATTACHMENT_BUNDLE_CONTRACT_INVALID');
  }
  const objectKeys = new Set<string>();
  const byReport = new Map<string, string[]>();
  let totalBytes = 0;
  for (const entry of bundle.attachments) {
    const fileName = entry.sourceRelativeKey.split('/').at(-1);
    const sourceSegments = entry.sourceRelativeKey.split('/');
    if (entry.byteSize > S3_CONDITIONAL_PUT_MAX_BYTES) {
      throw new Error('IMPORT_ATTACHMENT_EXCEEDS_CONDITIONAL_PUT_LIMIT');
    }
    if (
      !reportKeys.has(entry.reportKey) ||
      !fileName ||
      entry.sourceRelativeKey.startsWith('/') ||
      entry.sourceRelativeKey.includes('\\') ||
      sourceSegments.some(
        (segment) => segment.length === 0 || segment === '.' || segment === '..',
      ) ||
      /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(
        entry.sourceRelativeKey,
      ) ||
      Buffer.byteLength(fileName) > 255 ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      !Number.isSafeInteger(entry.byteSize) ||
      entry.byteSize < 0 ||
      entry.objectKey !==
        `migration/daily-reports/${entry.reportKey}/${entry.sha256}-${fileName}` ||
      objectKeys.has(entry.objectKey)
    ) {
      throw new Error('IMPORT_ATTACHMENT_BUNDLE_CONTRACT_INVALID');
    }
    objectKeys.add(entry.objectKey);
    const reportObjectKeys = byReport.get(entry.reportKey) ?? [];
    reportObjectKeys.push(entry.objectKey);
    byReport.set(entry.reportKey, reportObjectKeys);
    totalBytes += entry.byteSize;
    if (!Number.isSafeInteger(totalBytes)) {
      throw new Error('IMPORT_ATTACHMENT_BUNDLE_CONTRACT_INVALID');
    }
  }
  for (const report of bundle.dailyReports) {
    const expected = [...(byReport.get(report.reportKey) ?? [])].sort();
    const actual = [...report.attachmentKeys].sort();
    if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('IMPORT_ATTACHMENT_BUNDLE_CONTRACT_INVALID');
    }
  }
  const expectedSummary = {
    count: bundle.attachments.length,
    totalBytes,
    hashes: bundle.attachments
      .map(({ objectKey, sha256 }) => ({ objectKey, sha256 }))
      .sort((left, right) => left.objectKey.localeCompare(right.objectKey, 'en')),
  };
  const actualSummary = {
    ...bundle.sourceSummary.targetAttachmentSummary,
    hashes: [...bundle.sourceSummary.targetAttachmentSummary.hashes].sort((left, right) =>
      left.objectKey.localeCompare(right.objectKey, 'en'),
    ),
  };
  if (
    bundle.sourceSummary.modelCounts.attachments !== bundle.attachments.length ||
    JSON.stringify(expectedSummary) !== JSON.stringify(actualSummary)
  ) {
    throw new Error('IMPORT_ATTACHMENT_BUNDLE_CONTRACT_INVALID');
  }
}

function assertBundleSummary(bundle: MigrationBundle): void {
  const recomputed = buildMigrationSummary({
    shiftCount: bundle.shifts.length,
    responsiblePersonCount: bundle.responsiblePersons.length,
    appSetting: bundle.appSetting,
    reports: bundle.dailyReports,
    sourceFiles: [],
    attachments: bundle.attachments,
    warnings: bundle.sourceSummary.warnings,
    conflicts: [],
  });
  if (
    JSON.stringify(stableValue(recomputed.modelCounts)) !==
      JSON.stringify(stableValue(bundle.sourceSummary.modelCounts)) ||
    JSON.stringify(stableValue(recomputed.amounts)) !==
      JSON.stringify(stableValue(bundle.sourceSummary.amounts)) ||
    JSON.stringify(stableValue(recomputed.targetAttachmentSummary)) !==
      JSON.stringify(stableValue(bundle.sourceSummary.targetAttachmentSummary))
  ) {
    throw new Error('IMPORT_BUNDLE_SUMMARY_MISMATCH');
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_:-]+$/u.test(error.message)) {
    return error.message.slice(0, 300);
  }
  if (
    error instanceof Error &&
    /^TARGET_(?:(?:RECORD|ATTACHMENT)_(?:CONFLICT|CONDITIONAL_RACE)|ATTACHMENT_PUT_OUTCOME_UNKNOWN):[A-Za-z0-9_.:#/-]+$/u.test(
      error.message,
    )
  ) {
    return error.message.slice(0, 300);
  }
  return 'UNCLASSIFIED_TARGET_FAILURE';
}

function resolveAttachmentSource(uploadsRoot: string, relativeKey: string): string {
  if (!isAbsolute(uploadsRoot)) throw new Error('IMPORT_UPLOADS_ROOT_NOT_ABSOLUTE');
  const rootStat = lstatSync(uploadsRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('IMPORT_UPLOADS_ROOT_INVALID');
  }
  const canonicalRoot = realpathSync(uploadsRoot);
  if (relativeKey.length === 0 || relativeKey.startsWith('/') || relativeKey.includes('\\')) {
    throw new Error('IMPORT_ATTACHMENT_SOURCE_KEY_INVALID');
  }
  const source = resolve(canonicalRoot, relativeKey);
  const relation = relative(canonicalRoot, source);
  if (relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('IMPORT_ATTACHMENT_SOURCE_ESCAPE');
  }
  return source;
}

function recordsByStage(bundle: MigrationBundle): Record<MigrationModelName, Array<[string, Record<string, unknown>]>> {
  return {
    ShiftDefinition: bundle.shifts.map((record) => [
      record.id,
      amplifyDataTargetRecord('ShiftDefinition', { ...record }),
    ]),
    ResponsiblePerson: bundle.responsiblePersons.map((record) => [
      record.id,
      amplifyDataTargetRecord('ResponsiblePerson', { ...record }),
    ]),
    AppSetting: [[
      bundle.appSetting.id,
      amplifyDataTargetRecord('AppSetting', { ...bundle.appSetting }),
    ]],
    DailyReport: bundle.dailyReports.map((record) => [
      record.reportKey,
      amplifyDataTargetRecord('DailyReport', { ...record }),
    ]),
  };
}

export class MigrationImportError extends Error {
  readonly code = 'MIGRATION_IMPORT_FAILED';
  constructor(
    readonly stage: ImportStage,
    readonly failureCode: string,
    readonly checkpointPersisted = true,
    readonly checkpointFailureCode?: string,
  ) {
    super(`MIGRATION_IMPORT_FAILED:${stage}`);
  }
}

export function formatImportCliError(error: unknown): Record<string, unknown> {
  if (error instanceof MigrationImportError) {
    return {
      code: error.code,
      stage: error.stage,
      failureCode: error.failureCode,
      checkpointPersisted: error.checkpointPersisted,
      ...(error.checkpointFailureCode === undefined
        ? {}
        : { checkpointFailureCode: error.checkpointFailureCode }),
    };
  }
  return { code: errorCode(error) };
}

export async function importMigrationBundle(input: {
  mode: 'dry-run' | 'apply';
  approvalId?: string;
  bundle: MigrationBundle;
  uploadsRoot: string;
  target: MigrationTarget;
  checkpointStore: CheckpointStore;
  targetFingerprint?: string;
}): Promise<{
  status: 'dry-run' | 'complete';
  created: { records: number; attachments: number };
  unchanged: { records: number; attachments: number };
}> {
  assertBundleRecordContract(input.bundle);
  assertLinkedAttachmentBundleContract(input.bundle);
  assertBundleSummary(input.bundle);
  const emptyCounts = {
    created: { records: 0, attachments: 0 },
    unchanged: { records: 0, attachments: 0 },
  };
  if (input.mode === 'dry-run') {
    return { status: 'dry-run', ...emptyCounts };
  }
  if (!input.approvalId?.trim()) throw new Error('IMPORT_APPROVAL_ID_REQUIRED');
  await input.target.assertSafeTarget();
  const expectedBundleHash = bundleHash(input.bundle);
  const expectedTargetFingerprint =
    input.targetFingerprint ?? createHash('sha256').update('dependency-injected-target').digest('hex');
  const previous = await input.checkpointStore.load();
  if (
    previous &&
    (previous.bundleSha256 !== expectedBundleHash ||
      previous.targetFingerprint !== expectedTargetFingerprint)
  ) {
    throw new Error('IMPORT_CHECKPOINT_INPUT_MISMATCH');
  }
  const completedStages =
    previous?.status === 'complete' ? [] : (previous?.completedStages ?? []);
  const checkpoint: ImportCheckpoint = {
    version: 1,
    bundleSha256: expectedBundleHash,
    targetFingerprint: expectedTargetFingerprint,
    status: 'in-progress',
    completedStages: [...completedStages],
  };
  await input.checkpointStore.saveAtomic(checkpoint);
  const counts = emptyCounts;
  const records = recordsByStage(input.bundle);
  const stages: ImportStage[] = [...TARGET_MODEL_ORDER, 'Attachment'];
  for (const stage of stages) {
    if (checkpoint.completedStages.includes(stage)) continue;
    try {
      if (stage === 'Attachment') {
        for (const entry of input.bundle.attachments) {
          const outcome = await input.target.putAttachment(
            entry,
            resolveAttachmentSource(input.uploadsRoot, entry.sourceRelativeKey),
            input.uploadsRoot,
          );
          counts[outcome === 'created' ? 'created' : 'unchanged'].attachments += 1;
        }
      } else {
        for (const [key, record] of records[stage]) {
          const outcome = await input.target.putRecord(stage, key, record);
          counts[outcome === 'created' ? 'created' : 'unchanged'].records += 1;
        }
      }
      checkpoint.completedStages.push(stage);
      await input.checkpointStore.saveAtomic(checkpoint);
    } catch (error) {
      const failureCode = errorCode(error);
      try {
        await input.checkpointStore.saveAtomic({
          ...checkpoint,
          status: 'failed',
          failedStage: stage,
          failureCode,
        });
      } catch (checkpointError) {
        throw new MigrationImportError(
          stage,
          failureCode,
          false,
          errorCode(checkpointError),
        );
      }
      throw new MigrationImportError(stage, failureCode, true);
    }
  }
  await input.checkpointStore.saveAtomic({ ...checkpoint, status: 'complete' });
  return { status: 'complete', ...counts };
}

function readJson(path: string): unknown {
  if (!isAbsolute(path)) throw new Error('IMPORT_INPUT_PATH_NOT_ABSOLUTE');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('IMPORT_INPUT_PATH_INVALID');
  }
  return JSON.parse(readFileSync(realpathSync(path), 'utf8'));
}

export async function runImportCli(argv: string[]): Promise<unknown> {
  const options = parseImportCliOptions(argv);
  if (!options.bundlePath || !options.uploadsRoot || !options.checkpointPath) {
    throw new Error('IMPORT_REQUIRED_PATHS_MISSING');
  }
  const bundle = readJson(options.bundlePath) as MigrationBundle;
  if (options.mode === 'dry-run') {
    const inertTarget: MigrationTarget = {
      async assertSafeTarget() { throw new Error('DRY_RUN_TARGET_CALLED'); },
      async putRecord() { throw new Error('DRY_RUN_TARGET_CALLED'); },
      async putAttachment() { throw new Error('DRY_RUN_TARGET_CALLED'); },
      async listRecords() { throw new Error('DRY_RUN_TARGET_CALLED'); },
      async assertAttachmentObjectKeys() { throw new Error('DRY_RUN_TARGET_CALLED'); },
      async readAttachment() { throw new Error('DRY_RUN_TARGET_CALLED'); },
    };
    return importMigrationBundle({
      mode: 'dry-run',
      bundle,
      uploadsRoot: options.uploadsRoot,
      target: inertTarget,
      checkpointStore: new FileCheckpointStore(options.checkpointPath),
    });
  }
  const config = readJson(options.targetConfigPath!) as TargetConfiguration;
  assertExplicitTargetConfiguration(config);
  return importMigrationBundle({
    mode: 'apply',
    approvalId: options.approvalId,
    bundle,
    uploadsRoot: options.uploadsRoot,
    target: createAwsMigrationTarget(config),
    checkpointStore: new FileCheckpointStore(options.checkpointPath),
    targetFingerprint: targetConfigurationFingerprint(config),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runImportCli(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result)),
    (error: unknown) => {
      console.error(JSON.stringify(formatImportCliError(error)));
      process.exitCode = 1;
    },
  );
}
