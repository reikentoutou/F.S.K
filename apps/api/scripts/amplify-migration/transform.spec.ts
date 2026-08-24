import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMigrationBundle,
  normalizeLegacySubmittedAt,
  runDryRunCli,
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

async function createPrismaFixture(): Promise<{
  root: string;
  sqlitePath: string;
  uploadsPath: string;
  updatedAtEpochMs: number;
}> {
  const root = temporaryRoot();
  const sqlitePath = join(root, 'prisma-fixture.sqlite');
  const uploadsPath = join(root, 'uploads');
  mkdirSync(uploadsPath);
  const database = new DatabaseSync(sqlitePath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "User" (
      "id" TEXT PRIMARY KEY, "username" TEXT NOT NULL UNIQUE,
      "passwordHash" TEXT NOT NULL, "role" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL
    );
    CREATE TABLE "Shift" (
      "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL,
      "sortOrder" INTEGER NOT NULL, "active" BOOLEAN NOT NULL
    );
    CREATE TABLE "ResponsiblePerson" (
      "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "active" BOOLEAN NOT NULL
    );
    CREATE TABLE "AppSettings" (
      "id" TEXT PRIMARY KEY, "registerFloatAmount" INTEGER NOT NULL,
      "setupCompleted" BOOLEAN NOT NULL
    );
    CREATE TABLE "DailyReport" (
      "id" TEXT PRIMARY KEY, "reportDate" TEXT NOT NULL,
      "shiftId" TEXT NOT NULL REFERENCES "Shift"("id"),
      "shiftNameSnapshot" TEXT NOT NULL,
      "responsiblePersonId" TEXT NOT NULL REFERENCES "ResponsiblePerson"("id"),
      "responsiblePersonSnapshot" TEXT NOT NULL,
      "startMinuteOfDay" INTEGER NOT NULL, "endMinuteOfDay" INTEGER NOT NULL,
      "timeRangeLabelSnapshot" TEXT NOT NULL,
      "previousImosBalanceYen" INTEGER NOT NULL,
      "currentImosBalanceYen" INTEGER NOT NULL, "imosSalesYen" INTEGER NOT NULL,
      "newageYen" INTEGER NOT NULL, "cashTotalYen" INTEGER NOT NULL,
      "expenseYen" INTEGER NOT NULL, "expenseReason" TEXT,
      "staffMealCashYen" INTEGER NOT NULL,
      "staffMealAlipayYen" INTEGER NOT NULL,
      "totalSalesYen" INTEGER NOT NULL, "cashDepositYen" INTEGER NOT NULL,
      "deviationYen" INTEGER NOT NULL, "status" TEXT NOT NULL,
      "createdByUserId" TEXT NOT NULL REFERENCES "User"("id"),
      "updatedAt" DATETIME NOT NULL,
      UNIQUE("reportDate", "shiftId")
    );
  `);
  database.close();

  const prisma = new PrismaClient({ datasourceUrl: `file:${sqlitePath}` });
  const updatedAt = new Date('2026-08-23T15:01:02.345Z');
  try {
    await prisma.shift.create({
      data: { id: 'shift-day', name: '白班', sortOrder: 10, active: true },
    });
    await prisma.responsiblePerson.create({
      data: { id: 'person-1', name: '张三', active: true },
    });
    await prisma.appSettings.create({
      data: { id: 'default', registerFloatAmount: 5_000, setupCompleted: true },
    });
    await prisma.user.create({
      data: {
        id: 'user-kitchen',
        username: 'kitchen-old',
        passwordHash: '$2b$synthetic-only',
        role: 'WEBMASTER',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      },
    });
    await prisma.dailyReport.create({
      data: {
        id: 'legacy-report-1',
        reportDate: '2026-08-23',
        shiftId: 'shift-day',
        shiftNameSnapshot: '白班',
        responsiblePersonId: 'person-1',
        responsiblePersonSnapshot: '张三',
        startMinuteOfDay: 600,
        endMinuteOfDay: 900,
        timeRangeLabelSnapshot: '10:00 - 15:00',
        previousImosBalanceYen: 10_000,
        currentImosBalanceYen: 16_000,
        imosSalesYen: 6_000,
        newageYen: 8_000,
        cashTotalYen: 20_000,
        expenseYen: 300,
        expenseReason: '买菜',
        staffMealCashYen: 1_200,
        staffMealAlipayYen: 800,
        totalSalesYen: 21_800,
        cashDepositYen: 15_000,
        deviationYen: 16_100,
        status: 'approved',
        createdByUserId: 'user-kitchen',
        updatedAt,
      },
    });
  } finally {
    await prisma.$disconnect();
  }
  return {
    root,
    sqlitePath,
    uploadsPath,
    updatedAtEpochMs: updatedAt.getTime(),
  };
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe('SQLite migration transform', () => {
  it('normalizes the current PrismaClient epoch-millisecond DateTime to UTC ISO', async () => {
    const fixture = await createPrismaFixture();
    const database = new DatabaseSync(fixture.sqlitePath, { readOnly: true });
    const stored = database
      .prepare('SELECT "updatedAt" FROM "DailyReport"')
      .get() as { updatedAt: unknown };
    database.close();

    expect(stored.updatedAt).toBe(fixture.updatedAtEpochMs);
    expect(
      (await createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath))
        .dailyReports[0].submittedAt,
    ).toBe('2026-08-23T15:01:02.345Z');
  });

  it.each([
    ['ambiguous local timestamp', '2026-08-23 15:01:02'],
    ['invalid calendar timestamp', '2026-02-30T15:01:02.000Z'],
    ['fractional epoch milliseconds', 1.5],
    ['epoch milliseconds outside the Date range', 9_000_000_000_000_000],
    ['non-finite epoch milliseconds', Number.NaN],
  ])('rejects %s', (_label, invalidTimestamp) => {
    expect(() => normalizeLegacySubmittedAt(invalidTimestamp)).toThrow(
      'INVALID_SQLITE_SOURCE_FIELD:DailyReport.updatedAt',
    );
  });

  it('normalizes an explicitly zoned ISO string to UTC', () => {
    expect(normalizeLegacySubmittedAt('2026-08-24T00:01:02+09:00')).toBe(
      '2026-08-23T15:01:02.000Z',
    );
  });

  it('accepts a valid epoch-millisecond integer before 1970', () => {
    expect(normalizeLegacySubmittedAt(-1)).toBe(
      '1969-12-31T23:59:59.999Z',
    );
  });

  it('fails when SQLite foreign_key_check reports a broken source relation', async () => {
    const fixture = await createPrismaFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec('PRAGMA foreign_keys = OFF');
    database
      .prepare('UPDATE "DailyReport" SET "shiftId" = ?')
      .run('missing-shift');
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('SQLITE_FOREIGN_KEY_CHECK_FAILED');
  });

  it.each([
    [
      'shift',
      'UPDATE "DailyReport" SET "shiftId" = \'missing-shift\'',
      'SQLITE_SOURCE_REFERENCE_MISSING:DailyReport.shiftId',
    ],
    [
      'responsible person',
      'UPDATE "DailyReport" SET "responsiblePersonId" = \'missing-person\'',
      'SQLITE_SOURCE_REFERENCE_MISSING:DailyReport.responsiblePersonId',
    ],
    [
      'created-by user',
      'UPDATE "DailyReport" SET "createdByUserId" = \'missing-user\'',
      'SQLITE_SOURCE_REFERENCE_MISSING:DailyReport.createdByUserId',
    ],
  ])('fails when a report references a missing %s without FK metadata', async (_label, sql, code) => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec(sql);
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow(code);
  });

  it('requires the single AppSetting source row to use id=default', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec('UPDATE "AppSettings" SET "id" = \'other\'');
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('INVALID_APP_SETTING_ID');
  });

  it('validates register float even when the source has no reports', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec(
      'DELETE FROM "DailyReport"; UPDATE "AppSettings" SET "registerFloatAmount" = -1',
    );
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('INVALID_DAILY_REPORT_AMOUNT');
  });

  it.each([
    ['start minute below zero', '"startMinuteOfDay" = -1'],
    ['end minute above the final minute', '"endMinuteOfDay" = 1440'],
  ])('rejects %s', async (_label, assignment) => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec(`UPDATE "DailyReport" SET ${assignment}`);
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('INVALID_SQLITE_SOURCE_FIELD:DailyReport.minuteOfDay');
  });

  it('rejects a negative shift sort order', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec('UPDATE "Shift" SET "sortOrder" = -1 WHERE "id" = \'shift-day\'');
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('INVALID_SQLITE_SOURCE_FIELD:Shift.sortOrder');
  });

  it('rejects a whitespace-only source id', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec(
      'UPDATE "Shift" SET "id" = \'   \' WHERE "id" = \'shift-day\'; UPDATE "DailyReport" SET "shiftId" = \'   \'',
    );
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('INVALID_SQLITE_SOURCE_FIELD:Shift.id');
  });

  it.each([
    'previousImosBalanceYen',
    'currentImosBalanceYen',
    'newageYen',
    'cashTotalYen',
    'expenseYen',
    'staffMealCashYen',
    'staffMealAlipayYen',
  ])('domain-validates raw field %s', async (field) => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.sqlitePath);
    database.exec(`UPDATE "DailyReport" SET "${field}" = -1`);
    database.close();

    await expect(
      createMigrationBundle(fixture.sqlitePath, fixture.uploadsPath),
    ).rejects.toThrow('INVALID_DAILY_REPORT_AMOUNT');
  });

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
        attachmentKeys: [
          'migration/daily-reports/2026-08-23#shift-day/1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c-receipt.txt',
        ],
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
      summary: {
        conflicts: [
          {
            reportKey: '2026-08-23#shift-day',
            sourceIds: ['legacy-report-1', 'legacy-report-2'],
          },
        ],
        orphans: [
          'migration/orphans/88f6811ab5d8fc6d3177f9b7609ae0fcebfda187e5046b62d38bb539e88b74d7-unlinked.txt',
        ],
      },
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
          objectKey:
            'migration/daily-reports/2026-08-23#shift-day/1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c-receipt.txt',
          sha256: '1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c',
        },
        {
          objectKey:
            'migration/orphans/88f6811ab5d8fc6d3177f9b7609ae0fcebfda187e5046b62d38bb539e88b74d7-unlinked.txt',
          sha256: '88f6811ab5d8fc6d3177f9b7609ae0fcebfda187e5046b62d38bb539e88b74d7',
        },
      ],
    });
    expect(summary.orphans).toEqual([
      'migration/orphans/88f6811ab5d8fc6d3177f9b7609ae0fcebfda187e5046b62d38bb539e88b74d7-unlinked.txt',
    ]);
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
        objectKey:
          'migration/daily-reports/2026-08-23#shift-day/1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c-receipt.txt',
        byteSize: 11,
        sha256: '1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c',
        linkedReportKeys: ['2026-08-23#shift-day'],
        orphan: false,
      },
      {
        sourceRelativeKey: 'unlinked.txt',
        objectKey:
          'migration/orphans/88f6811ab5d8fc6d3177f9b7609ae0fcebfda187e5046b62d38bb539e88b74d7-unlinked.txt',
        byteSize: 6,
        sha256: '88f6811ab5d8fc6d3177f9b7609ae0fcebfda187e5046b62d38bb539e88b74d7',
        linkedReportKeys: [],
        orphan: true,
      },
    ]);
  });

  it('materializes one Task11-ready target entry per linked report', async () => {
    const fixture = createFixture();

    const inventory = await inventoryUploads(fixture.uploadsPath, [
      { legacyReportId: 'legacy-report-1', reportKey: '2026-08-23#shift-day' },
      { legacyReportId: 'legacy-report-1', reportKey: '2026-08-24#shift-day' },
    ]);

    expect(
      inventory
        .filter((entry) => !entry.orphan)
        .map((entry) => ({
          objectKey: entry.objectKey,
          linkedReportKeys: entry.linkedReportKeys,
        })),
    ).toEqual([
      {
        objectKey:
          'migration/daily-reports/2026-08-23#shift-day/1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c-receipt.txt',
        linkedReportKeys: ['2026-08-23#shift-day'],
      },
      {
        objectKey:
          'migration/daily-reports/2026-08-24#shift-day/1623126585a29ed7e9f756979339fe046226759931a22138be37316b76c6a36c-receipt.txt',
        linkedReportKeys: ['2026-08-24#shift-day'],
      },
    ]);
  });

  it('emits attachment keys that Task11 can consume without rewriting reports', async () => {
    const fixture = createFixture();
    const bundle = await createMigrationBundle(
      fixture.sqlitePath,
      fixture.uploadsPath,
    );

    for (const report of bundle.dailyReports) {
      expect(report.attachmentKeys).toEqual(
        bundle.attachments
          .filter((entry) => entry.linkedReportKeys.includes(report.reportKey))
          .map((entry) => entry.objectKey),
      );
      expect(report.attachmentKeys).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            new RegExp(
              `^migration/daily-reports/${report.reportKey}/[0-9a-f]{64}-.+`,
              'u',
            ),
          ),
        ]),
      );
    }
  });

  it('rejects an unsafe bidi filename instead of embedding it in a target key', async () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.uploadsPath, 'invoice\u202e.jpg'), 'unsafe');

    await expect(inventoryUploads(fixture.uploadsPath, [])).rejects.toThrow(
      'INVALID_STORAGE_FILE_NAME',
    );
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

  it('rejects a parent directory swapped to a symlink before file open', async () => {
    const fixture = createFixture();
    const declaredDirectory = join(fixture.uploadsPath, 'legacy-report-1');
    const movedDirectory = join(fixture.uploadsPath, 'legacy-report-1-moved');
    const outsideDirectory = join(fixture.root, 'outside-directory');
    mkdirSync(outsideDirectory);
    writeFileSync(join(outsideDirectory, 'receipt.txt'), 'replacement');

    await expect(
      inventoryUploads(
        fixture.uploadsPath,
        [],
        {
          beforeOpen: ({ sourceRelativeKey }) => {
            if (sourceRelativeKey !== 'legacy-report-1/receipt.txt') return;
            renameSync(declaredDirectory, movedDirectory);
            symlinkSync(outsideDirectory, declaredDirectory);
          },
        },
      ),
    ).rejects.toThrow('UPLOAD_PATH_NOT_CANONICAL');
  });

  it('rejects a same-size file mutation between hash read and post-stat', async () => {
    const fixture = createFixture();

    await expect(
      inventoryUploads(
        fixture.uploadsPath,
        [],
        {
          afterRead: ({ sourceRelativeKey, canonicalPath }) => {
            if (sourceRelativeKey === 'unlinked.txt') {
              writeFileSync(canonicalPath, 'change');
            }
          },
        },
      ),
    ).rejects.toThrow('UPLOAD_FILE_CHANGED');
  });

  it('rejects a special filesystem entry', async () => {
    const fixture = createFixture();
    const socketPath = join(fixture.uploadsPath, 'inventory.sock');
    const server = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(socketPath, resolveListen);
    });
    try {
      await expect(inventoryUploads(fixture.uploadsPath, [])).rejects.toThrow(
        'UPLOAD_PATH_NOT_CANONICAL',
      );
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
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

  it.each([
    ['inside uploads', (fixture: ReturnType<typeof createFixture>) => join(fixture.uploadsPath, 'output')],
    ['inside the SQLite file path', (fixture: ReturnType<typeof createFixture>) => join(fixture.sqlitePath, 'output')],
    ['as an ancestor of both sources', (fixture: ReturnType<typeof createFixture>) => fixture.root],
  ])('rejects output %s', async (_label, outputFor) => {
    const fixture = createFixture();

    await expect(
      runDryRunCli([
        '--sqlite',
        fixture.sqlitePath,
        '--uploads',
        fixture.uploadsPath,
        '--out',
        outputFor(fixture),
      ]),
    ).rejects.toThrow('MIGRATION_OUTPUT_SOURCE_OVERLAP');
  });

  it('rejects a SQLite source located inside the uploads source', async () => {
    const fixture = createFixture();
    const nestedSqlitePath = join(fixture.uploadsPath, 'fixture.sqlite');
    renameSync(fixture.sqlitePath, nestedSqlitePath);

    await expect(
      runDryRunCli([
        '--sqlite',
        nestedSqlitePath,
        '--uploads',
        fixture.uploadsPath,
        '--out',
        join(fixture.root, 'output'),
      ]),
    ).rejects.toThrow('MIGRATION_SOURCE_OVERLAP');
  });

  it('rejects an output ancestor that contains the repository', async () => {
    const fixture = createFixture();
    const repositoryAncestor = resolve(repositoryRoot, '..', '..', '..');

    await expect(
      runDryRunCli([
        '--sqlite',
        fixture.sqlitePath,
        '--uploads',
        fixture.uploadsPath,
        '--out',
        repositoryAncestor,
      ]),
    ).rejects.toThrow('MIGRATION_OUTPUT_INSIDE_REPOSITORY');
  });

  it('fails and leaves no output when the output parent is swapped before writing', async () => {
    const fixture = createFixture();
    const outputRoot = temporaryRoot();
    const safeParent = join(outputRoot, 'safe-parent');
    const movedParent = join(outputRoot, 'moved-parent');
    const replacementParent = join(outputRoot, 'replacement-parent');
    mkdirSync(safeParent);
    mkdirSync(replacementParent);
    const outputPath = join(safeParent, 'result');

    await expect(
      runDryRunCli(
        [
          '--sqlite',
          fixture.sqlitePath,
          '--uploads',
          fixture.uploadsPath,
          '--out',
          outputPath,
        ],
        repositoryRoot,
        {
          beforeOutputWrite: () => {
            renameSync(safeParent, movedParent);
            symlinkSync(replacementParent, safeParent);
          },
        },
      ),
    ).rejects.toThrow('MIGRATION_OUTPUT_PATH_CHANGED');
    expect(() => readFileSync(join(outputPath, 'migration-bundle.json'))).toThrow();
  });

  it('fails and leaves no output when the output parent is swapped before commit', async () => {
    const fixture = createFixture();
    const outputRoot = temporaryRoot();
    const safeParent = join(outputRoot, 'safe-parent');
    const movedParent = join(outputRoot, 'moved-parent');
    const replacementParent = join(outputRoot, 'replacement-parent');
    mkdirSync(safeParent);
    mkdirSync(replacementParent);
    const outputPath = join(safeParent, 'result');

    await expect(
      runDryRunCli(
        [
          '--sqlite',
          fixture.sqlitePath,
          '--uploads',
          fixture.uploadsPath,
          '--out',
          outputPath,
        ],
        repositoryRoot,
        {
          beforeOutputCommit: () => {
            renameSync(safeParent, movedParent);
            symlinkSync(replacementParent, safeParent);
          },
        },
      ),
    ).rejects.toThrow('MIGRATION_OUTPUT_PATH_CHANGED');
    expect(() => readFileSync(join(outputPath, 'migration-report.json'))).toThrow();
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

  it('writes a complete deterministic report but no bundle when report keys conflict', () => {
    const fixture = createFixture({ conflictingReport: true });
    const outputPath = join(fixture.root, 'conflict-output');

    const result = runCli([
      '--sqlite',
      fixture.sqlitePath,
      '--uploads',
      fixture.uploadsPath,
      '--out',
      outputPath,
    ]);

    expect(result.status).toBe(1);
    const reportBytes = readFileSync(
      join(outputPath, 'migration-report.json'),
      'utf8',
    );
    expect(JSON.parse(reportBytes)).toMatchObject({
      conflicts: [
        {
          reportKey: '2026-08-23#shift-day',
          sourceIds: ['legacy-report-1', 'legacy-report-2'],
        },
      ],
      orphans: [
        'migration/orphans/88f6811ab5d8fc6d3177f9b7609ae0fcebfda187e5046b62d38bb539e88b74d7-unlinked.txt',
      ],
    });
    expect(reportBytes.endsWith('\n')).toBe(true);
    expect(() => readFileSync(join(outputPath, 'migration-bundle.json'))).toThrow();

    const secondFixture = createFixture({ conflictingReport: true });
    const secondOutputPath = join(secondFixture.root, 'conflict-output');
    const secondResult = runCli([
      '--sqlite',
      secondFixture.sqlitePath,
      '--uploads',
      secondFixture.uploadsPath,
      '--out',
      secondOutputPath,
    ]);
    expect(secondResult.status).toBe(1);
    expect(
      readFileSync(join(secondOutputPath, 'migration-report.json'), 'utf8'),
    ).toBe(reportBytes);
  });
});
