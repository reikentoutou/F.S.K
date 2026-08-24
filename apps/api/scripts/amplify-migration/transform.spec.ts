import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMigrationBundle,
  serializeMigrationBundle,
} from './transform';
import { inventoryUploads } from './inventory';

const repositoryRoot = resolve(__dirname, '../../../..');
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'fsk-migration-test-'));
  temporaryRoots.push(root);
  return root;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function createFixture(options: { conflictingReport?: boolean } = {}): {
  root: string;
  sqlitePath: string;
  uploadsPath: string;
} {
  const root = temporaryRoot();
  const sqlitePath = join(root, 'fixture.sqlite');
  const uploadsPath = join(root, 'uploads');
  mkdirSync(uploadsPath);

  const database = new DatabaseSync(sqlitePath);
  database.exec(`
    CREATE TABLE "User" (
      "id" TEXT PRIMARY KEY,
      "username" TEXT NOT NULL,
      "passwordHash" TEXT NOT NULL,
      "role" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL
    );
    CREATE TABLE "Shift" (
      "id" TEXT PRIMARY KEY,
      "name" TEXT NOT NULL,
      "sortOrder" INTEGER NOT NULL,
      "active" BOOLEAN NOT NULL
    );
    CREATE TABLE "ResponsiblePerson" (
      "id" TEXT PRIMARY KEY,
      "name" TEXT NOT NULL,
      "active" BOOLEAN NOT NULL
    );
    CREATE TABLE "AppSettings" (
      "id" TEXT PRIMARY KEY,
      "registerFloatAmount" INTEGER NOT NULL,
      "setupCompleted" BOOLEAN NOT NULL
    );
    CREATE TABLE "DailyReport" (
      "id" TEXT PRIMARY KEY,
      "reportDate" TEXT NOT NULL,
      "shiftId" TEXT NOT NULL,
      "shiftNameSnapshot" TEXT NOT NULL,
      "responsiblePersonId" TEXT NOT NULL,
      "responsiblePersonSnapshot" TEXT NOT NULL,
      "startMinuteOfDay" INTEGER NOT NULL,
      "endMinuteOfDay" INTEGER NOT NULL,
      "timeRangeLabelSnapshot" TEXT NOT NULL,
      "previousImosBalanceYen" INTEGER NOT NULL,
      "currentImosBalanceYen" INTEGER NOT NULL,
      "imosSalesYen" INTEGER NOT NULL,
      "newageYen" INTEGER NOT NULL,
      "cashTotalYen" INTEGER NOT NULL,
      "expenseYen" INTEGER NOT NULL,
      "expenseReason" TEXT,
      "staffMealCashYen" INTEGER NOT NULL,
      "staffMealAlipayYen" INTEGER NOT NULL,
      "totalSalesYen" INTEGER NOT NULL,
      "cashDepositYen" INTEGER NOT NULL,
      "deviationYen" INTEGER NOT NULL,
      "status" TEXT NOT NULL,
      "createdByUserId" TEXT NOT NULL,
      "updatedAt" DATETIME NOT NULL
    );
  `);
  database.prepare(
    'INSERT INTO "User" VALUES (?, ?, ?, ?, ?)',
  ).run('user-kitchen', 'kitchen-old', '$2b$secret-hash', 'WEBMASTER', '2024-01-01T00:00:00.000Z');
  database.prepare('INSERT INTO "Shift" VALUES (?, ?, ?, ?)').run(
    'shift-night',
    '夜班',
    20,
    1,
  );
  database.prepare('INSERT INTO "Shift" VALUES (?, ?, ?, ?)').run(
    'shift-day',
    '白班',
    10,
    0,
  );
  database.prepare('INSERT INTO "ResponsiblePerson" VALUES (?, ?, ?)').run(
    'person-2',
    '李四',
    0,
  );
  database.prepare('INSERT INTO "ResponsiblePerson" VALUES (?, ?, ?)').run(
    'person-1',
    '张三',
    1,
  );
  database.prepare('INSERT INTO "AppSettings" VALUES (?, ?, ?)').run(
    'default',
    5_000,
    1,
  );

  const insertReport = database.prepare(`
    INSERT INTO "DailyReport" VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);
  insertReport.run(
    'legacy-report-1',
    '2026-08-23',
    'shift-day',
    '历史白班',
    'person-1',
    '历史张三',
    600,
    900,
    '10:00 - 15:00',
    10_000,
    16_000,
    999_001,
    8_000,
    20_000,
    300,
    '买菜',
    1_200,
    800,
    999_002,
    999_003,
    999_004,
    'approved',
    'user-kitchen',
    '2026-08-23T15:01:02.000Z',
  );
  if (options.conflictingReport) {
    insertReport.run(
      'legacy-report-2',
      '2026-08-23',
      'shift-day',
      '白班',
      'person-2',
      '李四',
      610,
      910,
      '10:10 - 15:10',
      1,
      2,
      1,
      3,
      4,
      0,
      null,
      0,
      0,
      2,
      -4_996,
      1,
      'approved',
      'user-kitchen',
      '2026-08-23T15:02:00.000Z',
    );
  }
  database.close();

  mkdirSync(join(uploadsPath, 'legacy-report-1'));
  writeFileSync(join(uploadsPath, 'legacy-report-1', 'receipt.txt'), 'receipt-one');
  writeFileSync(join(uploadsPath, 'unlinked.txt'), 'orphan');
  return { root, sqlitePath, uploadsPath };
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe('SQLite migration transform', () => {
  it('preserves source records and maps a legacy report to the DynamoDB contract', async () => {
    const fixture = createFixture();

    const bundle = await createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath);

    expect(bundle.shifts).toEqual([
      { id: 'shift-day', name: '白班', sortOrder: 10, active: false },
      { id: 'shift-night', name: '夜班', sortOrder: 20, active: true },
    ]);
    expect(bundle.responsiblePersons).toEqual([
      { id: 'person-1', name: '张三', active: true },
      { id: 'person-2', name: '李四', active: false },
    ]);
    expect(bundle.appSetting).toEqual({
      id: 'default',
      registerFloatAmount: 5_000,
      setupCompleted: true,
    });
    expect(bundle.dailyReports).toEqual([
      {
        reportKey: '2026-08-23#shift-day',
        businessDate: '2026-08-23',
        shiftId: 'shift-day',
        shiftNameSnapshot: '历史白班',
        responsiblePersonId: 'person-1',
        responsiblePersonSnapshot: '历史张三',
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
        attachmentKeys: ['migration/uploads/legacy-report-1/receipt.txt'],
        submittedAt: '2026-08-23T15:01:02.000Z',
        legacySubmittedByUsername: 'kitchen-old',
      },
    ]);
    expect(bundle.sourceSummary.warnings).toEqual([
      {
        code: 'LEGACY_SUBMITTED_AT_FROM_UPDATED_AT',
        sourceId: 'legacy-report-1',
      },
    ]);
    expect(JSON.stringify(bundle)).not.toContain('$2b$secret-hash');
    expect(bundle.dailyReports[0]).not.toHaveProperty('owner');
    expect(bundle.dailyReports[0]).not.toHaveProperty('createdByUserId');
    expect(bundle.dailyReports[0]).not.toHaveProperty('role');
  });

  it('serializes identical source content byte-for-byte deterministically', async () => {
    const first = createFixture();
    const second = createFixture();

    const firstJson = serializeMigrationBundle(
      await createMigrationBundle(first.sqlitePath, first.uploadsPath),
    );
    const secondJson = serializeMigrationBundle(
      await createMigrationBundle(second.sqlitePath, second.uploadsPath),
    );

    expect(firstJson).toBe(secondJson);
  });

  it('fails closed and reports both source ids for a duplicate report key', async () => {
    const fixture = createFixture({ conflictingReport: true });

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toMatchObject({
      code: 'MIGRATION_REPORT_KEY_CONFLICT',
      conflicts: [
        {
          reportKey: '2026-08-23#shift-day',
          sourceIds: ['legacy-report-1', 'legacy-report-2'],
        },
      ],
    });
  });

  it('reports exact raw and shared-domain-derived reconciliation totals', async () => {
    const fixture = createFixture();

    const summary = (await createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath))
      .sourceSummary;

    expect(summary.modelCounts).toEqual({
      shifts: 2,
      responsiblePersons: 2,
      appSettings: 1,
      dailyReports: 1,
      attachments: 2,
    });
    expect(summary.amounts).toEqual({
      byBusinessDate: {
        '2026-08-23': {
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
    });
    expect(summary.attachmentSummary).toEqual({
      count: 2,
      totalBytes: 17,
      hashes: [
        {
          objectKey: 'migration/uploads/legacy-report-1/receipt.txt',
          sha256: '1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c',
        },
        {
          objectKey: 'migration/uploads/unlinked.txt',
          sha256: '88f6811ab5d8fc6d3177f9b7609ae0fcebfda187e5046b62d38bb539e88b74d7',
        },
      ],
    });
    expect(summary.orphans).toEqual(['migration/uploads/unlinked.txt']);
    expect(summary.conflicts).toEqual([]);
  });
});

describe('uploads inventory safety', () => {
  it('records canonical keys, hashes, report clues and orphan state', async () => {
    const fixture = createFixture();

    const inventory = await inventoryUploads(fixture.uploadsPath, [
      { legacyReportId: 'legacy-report-1', reportKey: '2026-08-23#shift-day' },
    ]);

    expect(inventory).toEqual([
      {
        sourceRelativeKey: 'legacy-report-1/receipt.txt',
        objectKey: 'migration/uploads/legacy-report-1/receipt.txt',
        byteSize: 11,
        sha256: '1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c',
        linkedReportKeys: ['2026-08-23#shift-day'],
        orphan: false,
      },
      {
        sourceRelativeKey: 'unlinked.txt',
        objectKey: 'migration/uploads/unlinked.txt',
        byteSize: 6,
        sha256: '88f6811ab5d8fc6d3177f9b7609ae0fcebfda187e5046b62d38bb539e88b74d7',
        linkedReportKeys: [],
        orphan: true,
      },
    ]);
  });

  it('rejects a symlink that escapes the uploads root', async () => {
    const fixture = createFixture();
    const outside = join(fixture.root, 'outside.txt');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(fixture.uploadsPath, 'escape.txt'));

    await expect(inventoryUploads(fixture.uploadsPath, [])).rejects.toThrow(
      'UPLOAD_PATH_NOT_CANONICAL',
    );
  });

  it('rejects two source paths that normalize to the same object key', async () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.uploadsPath, 'duplicate'));
    writeFileSync(join(fixture.uploadsPath, 'duplicate', 'same.txt'), 'one');
    writeFileSync(join(fixture.uploadsPath, 'duplicate\\same.txt'), 'two');

    await expect(inventoryUploads(fixture.uploadsPath, [])).rejects.toThrow(
      'DUPLICATE_UPLOAD_KEY',
    );
  });

  it('fails closed when a file cannot be hashed', async () => {
    const fixture = createFixture();
    const unreadable = join(fixture.uploadsPath, 'unreadable.txt');
    writeFileSync(unreadable, 'secret');
    chmodSync(unreadable, 0o000);
    try {
      await expect(inventoryUploads(fixture.uploadsPath, [])).rejects.toThrow(
        'UPLOAD_HASH_FAILED',
      );
    } finally {
      chmodSync(unreadable, 0o600);
    }
  });
});

describe('dry-run CLI', () => {
  function runCli(args: string[]) {
    return spawnSync(
      'pnpm',
      ['exec', 'tsx', 'apps/api/scripts/amplify-migration/transform.ts', ...args],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
  }

  it('requires explicit sqlite, uploads and out arguments', () => {
    const result = runCli([]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MIGRATION_ARGUMENT_REQUIRED');
  });

  it('rejects an output directory inside the repository', () => {
    const fixture = createFixture();
    const result = runCli([
      '--sqlite',
      fixture.sqlitePath,
      '--uploads',
      fixture.uploadsPath,
      '--out',
      join(repositoryRoot, 'forbidden-migration-output'),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MIGRATION_OUTPUT_INSIDE_REPOSITORY');
  });

  it('rejects output in the primary checkout that contains this linked worktree', () => {
    const primaryCheckout = resolve(repositoryRoot, '..', '..');
    const result = runCli([
      '--sqlite',
      join(primaryCheckout, 'missing-fixture.sqlite'),
      '--uploads',
      join(primaryCheckout, 'missing-uploads'),
      '--out',
      join(primaryCheckout, 'forbidden-migration-output'),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MIGRATION_OUTPUT_INSIDE_REPOSITORY');
  });

  it('writes a deterministic bundle and report outside the repository without changing sources', () => {
    const fixture = createFixture();
    const outputPath = join(fixture.root, 'dry-run-output');
    const databaseHashBefore = sha256(fixture.sqlitePath);
    const uploadHashBefore = sha256(
      join(fixture.uploadsPath, 'legacy-report-1', 'receipt.txt'),
    );

    const result = runCli([
      '--sqlite',
      fixture.sqlitePath,
      '--uploads',
      fixture.uploadsPath,
      '--out',
      outputPath,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(outputPath, 'migration-bundle.json'), 'utf8')))
      .toMatchObject({ dailyReports: [{ reportKey: '2026-08-23#shift-day' }] });
    expect(JSON.parse(readFileSync(join(outputPath, 'migration-report.json'), 'utf8')))
      .toMatchObject({ modelCounts: { dailyReports: 1 }, conflicts: [] });
    expect(sha256(fixture.sqlitePath)).toBe(databaseHashBefore);
    expect(
      sha256(join(fixture.uploadsPath, 'legacy-report-1', 'receipt.txt')),
    ).toBe(uploadHashBefore);
  });
});
