import { randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assertDailyReportRawAmounts,
  dailyReportKey,
} from '@fsk/domain';
import type {
  AppSettingRecord,
  DailyReportRecord,
  MigrationBundle,
  MigrationConflict,
  ResponsiblePersonRecord,
  ShiftDefinitionRecord,
} from './contracts';
import { inventoryUploads } from './inventory';
import { buildMigrationSummary, serializeMigrationReport } from './report';

interface LegacyDailyReportRow {
  id: unknown;
  reportDate: unknown;
  shiftId: unknown;
  shiftNameSnapshot: unknown;
  responsiblePersonId: unknown;
  responsiblePersonSnapshot: unknown;
  startMinuteOfDay: unknown;
  endMinuteOfDay: unknown;
  timeRangeLabelSnapshot: unknown;
  previousImosBalanceYen: unknown;
  currentImosBalanceYen: unknown;
  newageYen: unknown;
  cashTotalYen: unknown;
  expenseYen: unknown;
  expenseReason: unknown;
  staffMealCashYen: unknown;
  staffMealAlipayYen: unknown;
  updatedAt: unknown;
  username: unknown;
}

interface LegacyDailyReport {
  sourceId: string;
  record: DailyReportRecord;
}

export class MigrationReportKeyConflictError extends Error {
  readonly code = 'MIGRATION_REPORT_KEY_CONFLICT';

  constructor(readonly conflicts: MigrationConflict[]) {
    super('MIGRATION_REPORT_KEY_CONFLICT');
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`INVALID_SQLITE_SOURCE_FIELD:${field}`);
  }
  return value;
}

function sourceNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`INVALID_SQLITE_SOURCE_FIELD:${field}`);
  }
  return value;
}

function sourceInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`INVALID_SQLITE_SOURCE_FIELD:${field}`);
  }
  return value as number;
}

function sourceBoolean(value: unknown, field: string): boolean {
  if (value !== 0 && value !== 1) {
    throw new Error(`INVALID_SQLITE_SOURCE_FIELD:${field}`);
  }
  return value === 1;
}

function sourceTimestamp(value: unknown): string {
  const source = sourceString(value, 'DailyReport.updatedAt');
  const parsed = new Date(source);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('INVALID_SQLITE_SOURCE_FIELD:DailyReport.updatedAt');
  }
  return parsed.toISOString();
}

function queryRows<T>(database: DatabaseSync, sql: string): T[] {
  return database.prepare(sql).all() as unknown as T[];
}

function readSource(sqlitePath: string): {
  shifts: ShiftDefinitionRecord[];
  responsiblePersons: ResponsiblePersonRecord[];
  appSetting: AppSettingRecord;
  reports: LegacyDailyReport[];
} {
  const declaredPath = resolve(sqlitePath);
  const sourceStat = lstatSync(declaredPath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error('SQLITE_SOURCE_NOT_CANONICAL');
  }
  const canonicalPath = realpathSync(declaredPath);
  const database = new DatabaseSync(canonicalPath, { readOnly: true });
  try {
    database.exec('PRAGMA query_only = ON');
    const shifts = queryRows<Record<string, unknown>>(
      database,
      'SELECT "id", "name", "sortOrder", "active" FROM "Shift" ORDER BY "sortOrder" ASC, "id" ASC',
    ).map((row) => ({
      id: sourceString(row.id, 'Shift.id'),
      name: sourceString(row.name, 'Shift.name'),
      sortOrder: sourceInteger(row.sortOrder, 'Shift.sortOrder'),
      active: sourceBoolean(row.active, 'Shift.active'),
    }));
    const responsiblePersons = queryRows<Record<string, unknown>>(
      database,
      'SELECT "id", "name", "active" FROM "ResponsiblePerson" ORDER BY "id" ASC',
    ).map((row) => ({
      id: sourceString(row.id, 'ResponsiblePerson.id'),
      name: sourceString(row.name, 'ResponsiblePerson.name'),
      active: sourceBoolean(row.active, 'ResponsiblePerson.active'),
    }));
    const settings = queryRows<Record<string, unknown>>(
      database,
      'SELECT "id", "registerFloatAmount", "setupCompleted" FROM "AppSettings" ORDER BY "id" ASC',
    );
    if (settings.length !== 1) throw new Error('INVALID_APP_SETTING_COUNT');
    const appSetting: AppSettingRecord = {
      id: sourceString(settings[0].id, 'AppSettings.id'),
      registerFloatAmount: sourceInteger(
        settings[0].registerFloatAmount,
        'AppSettings.registerFloatAmount',
      ),
      setupCompleted: sourceBoolean(
        settings[0].setupCompleted,
        'AppSettings.setupCompleted',
      ),
    };

    const rows = queryRows<LegacyDailyReportRow>(database, `
      SELECT
        report."id", report."reportDate", report."shiftId",
        report."shiftNameSnapshot", report."responsiblePersonId",
        report."responsiblePersonSnapshot", report."startMinuteOfDay",
        report."endMinuteOfDay", report."timeRangeLabelSnapshot",
        report."previousImosBalanceYen", report."currentImosBalanceYen",
        report."newageYen", report."cashTotalYen", report."expenseYen",
        report."expenseReason", report."staffMealCashYen",
        report."staffMealAlipayYen", report."updatedAt", user."username"
      FROM "DailyReport" AS report
      LEFT JOIN "User" AS user ON user."id" = report."createdByUserId"
      ORDER BY report."reportDate" ASC, report."shiftId" ASC, report."id" ASC
    `);
    const reports = rows.map((row): LegacyDailyReport => {
      const sourceId = sourceString(row.id, 'DailyReport.id');
      const businessDate = sourceString(row.reportDate, 'DailyReport.reportDate');
      const shiftId = sourceString(row.shiftId, 'DailyReport.shiftId');
      const raw = {
        previousImosBalanceYen: sourceInteger(
          row.previousImosBalanceYen,
          'DailyReport.previousImosBalanceYen',
        ),
        currentImosBalanceYen: sourceInteger(
          row.currentImosBalanceYen,
          'DailyReport.currentImosBalanceYen',
        ),
        newageYen: sourceInteger(row.newageYen, 'DailyReport.newageYen'),
        cashTotalYen: sourceInteger(
          row.cashTotalYen,
          'DailyReport.cashTotalYen',
        ),
        expenseYen: sourceInteger(row.expenseYen, 'DailyReport.expenseYen'),
        staffMealCashYen: sourceInteger(
          row.staffMealCashYen,
          'DailyReport.staffMealCashYen',
        ),
        staffMealAlipayYen: sourceInteger(
          row.staffMealAlipayYen,
          'DailyReport.staffMealAlipayYen',
        ),
      };
      assertDailyReportRawAmounts(raw);
      const username =
        row.username === null
          ? undefined
          : sourceString(row.username, 'User.username');
      return {
        sourceId,
        record: {
          reportKey: dailyReportKey(businessDate, shiftId),
          businessDate,
          shiftId,
          shiftNameSnapshot: sourceString(
            row.shiftNameSnapshot,
            'DailyReport.shiftNameSnapshot',
          ),
          responsiblePersonId: sourceString(
            row.responsiblePersonId,
            'DailyReport.responsiblePersonId',
          ),
          responsiblePersonSnapshot: sourceString(
            row.responsiblePersonSnapshot,
            'DailyReport.responsiblePersonSnapshot',
          ),
          startMinuteOfDay: sourceInteger(
            row.startMinuteOfDay,
            'DailyReport.startMinuteOfDay',
          ),
          endMinuteOfDay: sourceInteger(
            row.endMinuteOfDay,
            'DailyReport.endMinuteOfDay',
          ),
          timeRangeLabelSnapshot: sourceString(
            row.timeRangeLabelSnapshot,
            'DailyReport.timeRangeLabelSnapshot',
          ),
          ...raw,
          expenseReason: sourceNullableString(
            row.expenseReason,
            'DailyReport.expenseReason',
          ),
          attachmentKeys: [],
          submittedAt: sourceTimestamp(row.updatedAt),
          ...(username ? { legacySubmittedByUsername: username } : {}),
        },
      };
    });
    return { shifts, responsiblePersons, appSetting, reports };
  } finally {
    database.close();
  }
}

function assertNoReportKeyConflicts(reports: LegacyDailyReport[]): void {
  const sourcesByKey = new Map<string, string[]>();
  for (const report of reports) {
    const sourceIds = sourcesByKey.get(report.record.reportKey) ?? [];
    sourceIds.push(report.sourceId);
    sourcesByKey.set(report.record.reportKey, sourceIds);
  }
  const conflicts = [...sourcesByKey.entries()]
    .filter(([, sourceIds]) => sourceIds.length > 1)
    .map(([reportKey, sourceIds]) => ({
      reportKey,
      sourceIds: [...sourceIds].sort(compareText),
    }))
    .sort((left, right) => compareText(left.reportKey, right.reportKey));
  if (conflicts.length > 0) throw new MigrationReportKeyConflictError(conflicts);
}

export async function createMigrationBundle(
  sqlitePath: string,
  uploadsPath: string,
): Promise<MigrationBundle> {
  const source = readSource(sqlitePath);
  assertNoReportKeyConflicts(source.reports);
  const attachments = await inventoryUploads(
    uploadsPath,
    source.reports.map((report) => ({
      legacyReportId: report.sourceId,
      reportKey: report.record.reportKey,
    })),
  );
  const dailyReports = source.reports.map(({ record }) => ({
    ...record,
    attachmentKeys: attachments
      .filter((entry) => entry.linkedReportKeys.includes(record.reportKey))
      .map((entry) => entry.objectKey),
  }));
  const warnings = source.reports.map(({ sourceId }) => ({
    code: 'LEGACY_SUBMITTED_AT_FROM_UPDATED_AT' as const,
    sourceId,
  }));
  const sourceSummary = buildMigrationSummary({
    shiftCount: source.shifts.length,
    responsiblePersonCount: source.responsiblePersons.length,
    appSetting: source.appSetting,
    reports: dailyReports,
    attachments,
    warnings,
  });
  return {
    shifts: source.shifts,
    responsiblePersons: source.responsiblePersons,
    appSetting: source.appSetting,
    dailyReports,
    attachments,
    sourceSummary,
  };
}

export function serializeMigrationBundle(bundle: MigrationBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

interface CliArguments {
  sqlitePath: string;
  uploadsPath: string;
  outputPath: string;
}

function parseCliArguments(args: string[]): CliArguments {
  const values = new Map<string, string>();
  const allowed = new Set(['--sqlite', '--uploads', '--out']);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag) || !value || value.startsWith('--')) {
      throw new Error('MIGRATION_ARGUMENT_INVALID');
    }
    if (values.has(flag)) throw new Error('MIGRATION_ARGUMENT_DUPLICATE');
    values.set(flag, value);
  }
  if (!values.has('--sqlite') || !values.has('--uploads') || !values.has('--out')) {
    throw new Error('MIGRATION_ARGUMENT_REQUIRED');
  }
  return {
    sqlitePath: values.get('--sqlite')!,
    uploadsPath: values.get('--uploads')!,
    outputPath: values.get('--out')!,
  };
}

function canonicalFuturePath(path: string): string {
  const suffix: string[] = [];
  let current = resolve(path);
  while (true) {
    try {
      const canonicalParent = realpathSync(current);
      return resolve(canonicalParent, ...suffix.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error('MIGRATION_OUTPUT_PATH_INVALID');
      suffix.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== '..' &&
      !isAbsolute(pathFromRoot))
  );
}

function repositoryBoundaries(repositoryRoot: string): string[] {
  const boundaries = new Set<string>();
  const canonicalRoot = realpathSync(repositoryRoot);
  boundaries.add(canonicalRoot);
  let current = canonicalRoot;
  while (true) {
    try {
      lstatSync(join(current, '.git'));
      boundaries.add(realpathSync(current));
    } catch {
      // Not a checkout boundary; continue looking for a containing checkout.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...boundaries];
}

export async function runDryRunCli(
  args: string[],
  repositoryRoot = resolve(__dirname, '../../../..'),
): Promise<void> {
  const parsed = parseCliArguments(args);
  const outputPath = canonicalFuturePath(parsed.outputPath);
  if (
    repositoryBoundaries(repositoryRoot).some((boundary) =>
      isInside(boundary, outputPath),
    )
  ) {
    throw new Error('MIGRATION_OUTPUT_INSIDE_REPOSITORY');
  }
  try {
    lstatSync(outputPath);
    throw new Error('MIGRATION_OUTPUT_ALREADY_EXISTS');
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'MIGRATION_OUTPUT_ALREADY_EXISTS'
    ) {
      throw error;
    }
  }

  const bundle = await createMigrationBundle(
    parsed.sqlitePath,
    parsed.uploadsPath,
  );
  const temporaryOutput = join(
    dirname(outputPath),
    `.${outputPath.split(sep).at(-1)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
  );
  mkdirSync(temporaryOutput, { recursive: false, mode: 0o700 });
  try {
    writeFileSync(
      join(temporaryOutput, 'migration-bundle.json'),
      serializeMigrationBundle(bundle),
      { mode: 0o600 },
    );
    writeFileSync(
      join(temporaryOutput, 'migration-report.json'),
      serializeMigrationReport(bundle.sourceSummary),
      { mode: 0o600 },
    );
    renameSync(temporaryOutput, outputPath);
  } catch (error) {
    rmSync(temporaryOutput, { recursive: true, force: true });
    throw error;
  }
}

if (require.main === module) {
  runDryRunCli(process.argv.slice(2)).catch((error: unknown) => {
    const details =
      error instanceof MigrationReportKeyConflictError
        ? ` ${JSON.stringify(error.conflicts)}`
        : '';
    const message = error instanceof Error ? error.message : 'MIGRATION_FAILED';
    process.stderr.write(`${message}${details}\n`);
    process.exitCode = 1;
  });
}
