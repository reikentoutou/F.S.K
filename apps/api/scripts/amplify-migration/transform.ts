import {
  lstatSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assertDailyReportRawAmounts,
  computeDailyReportTotals,
  dailyReportKey,
} from '@fsk/domain';
import type {
  AppSettingRecord,
  DailyReportRecord,
  MigrationBundle,
  MigrationConflict,
  MigrationSummary,
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
  createdByUserId: unknown;
  updatedAt: unknown;
  username: unknown;
}

interface LegacyDailyReport {
  sourceId: string;
  record: DailyReportRecord;
}

export class MigrationReportKeyConflictError extends Error {
  readonly code = 'MIGRATION_REPORT_KEY_CONFLICT';

  constructor(
    readonly conflicts: MigrationConflict[],
    readonly summary: MigrationSummary,
  ) {
    super('MIGRATION_REPORT_KEY_CONFLICT');
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
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

function sourceNonNegativeInteger(value: unknown, field: string): number {
  const integer = sourceInteger(value, field);
  if (integer < 0) throw new Error(`INVALID_SQLITE_SOURCE_FIELD:${field}`);
  return integer;
}

function sourceMinute(value: unknown): number {
  const minute = sourceInteger(value, 'DailyReport.minuteOfDay');
  if (minute < 0 || minute > 1439) {
    throw new Error('INVALID_SQLITE_SOURCE_FIELD:DailyReport.minuteOfDay');
  }
  return minute;
}

function sourceBoolean(value: unknown, field: string): boolean {
  if (value !== 0 && value !== 1) {
    throw new Error(`INVALID_SQLITE_SOURCE_FIELD:${field}`);
  }
  return value === 1;
}

const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;
const EXPLICITLY_ZONED_ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|[+-](\d{2}):(\d{2}))$/u;

function isValidExplicitIsoTimestamp(value: string): boolean {
  const match = EXPLICITLY_ZONED_ISO_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

export function normalizeLegacySubmittedAt(value: unknown): string {
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= -MAX_DATE_EPOCH_MS &&
    value <= MAX_DATE_EPOCH_MS
  ) {
    return new Date(value).toISOString();
  }
  if (
    typeof value !== 'string' ||
    !isValidExplicitIsoTimestamp(value)
  ) {
    throw new Error('INVALID_SQLITE_SOURCE_FIELD:DailyReport.updatedAt');
  }
  const parsed = new Date(value);
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
    if (
      queryRows<Record<string, unknown>>(
        database,
        'PRAGMA foreign_key_check',
      ).length > 0
    ) {
      throw new Error('SQLITE_FOREIGN_KEY_CHECK_FAILED');
    }
    const shifts = queryRows<Record<string, unknown>>(
      database,
      'SELECT "id", "name", "sortOrder", "active" FROM "Shift" ORDER BY "sortOrder" ASC, "id" ASC',
    ).map((row) => ({
      id: sourceString(row.id, 'Shift.id'),
      name: sourceString(row.name, 'Shift.name'),
      sortOrder: sourceNonNegativeInteger(row.sortOrder, 'Shift.sortOrder'),
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
    if (settings[0].id !== 'default') throw new Error('INVALID_APP_SETTING_ID');
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
    computeDailyReportTotals(
      {
        previousImosBalanceYen: 0,
        currentImosBalanceYen: 0,
        newageYen: 0,
        cashTotalYen: 0,
        expenseYen: 0,
        staffMealCashYen: 0,
        staffMealAlipayYen: 0,
      },
      appSetting.registerFloatAmount,
    );

    const rows = queryRows<LegacyDailyReportRow>(database, `
      SELECT
        report."id", report."reportDate", report."shiftId",
        report."shiftNameSnapshot", report."responsiblePersonId",
        report."responsiblePersonSnapshot", report."startMinuteOfDay",
        report."endMinuteOfDay", report."timeRangeLabelSnapshot",
        report."previousImosBalanceYen", report."currentImosBalanceYen",
        report."newageYen", report."cashTotalYen", report."expenseYen",
        report."expenseReason", report."staffMealCashYen",
        report."staffMealAlipayYen", report."createdByUserId",
        report."updatedAt", user."username"
      FROM "DailyReport" AS report
      LEFT JOIN "User" AS user ON user."id" = report."createdByUserId"
      ORDER BY report."reportDate" ASC, report."shiftId" ASC, report."id" ASC
    `);
    const shiftIds = new Set(shifts.map((shift) => shift.id));
    const responsiblePersonIds = new Set(
      responsiblePersons.map((person) => person.id),
    );
    const users = queryRows<Record<string, unknown>>(
      database,
      'SELECT "id", "username" FROM "User" ORDER BY "id" ASC',
    );
    const usernamesByUserId = new Map(
      users.map((user) => [
        sourceString(user.id, 'User.id'),
        sourceString(user.username, 'User.username'),
      ]),
    );
    const reports = rows.map((row): LegacyDailyReport => {
      const sourceId = sourceString(row.id, 'DailyReport.id');
      const businessDate = sourceString(row.reportDate, 'DailyReport.reportDate');
      const shiftId = sourceString(row.shiftId, 'DailyReport.shiftId');
      if (!shiftIds.has(shiftId)) {
        throw new Error('SQLITE_SOURCE_REFERENCE_MISSING:DailyReport.shiftId');
      }
      const responsiblePersonId = sourceString(
        row.responsiblePersonId,
        'DailyReport.responsiblePersonId',
      );
      if (!responsiblePersonIds.has(responsiblePersonId)) {
        throw new Error(
          'SQLITE_SOURCE_REFERENCE_MISSING:DailyReport.responsiblePersonId',
        );
      }
      const createdByUserId = sourceString(
        row.createdByUserId,
        'DailyReport.createdByUserId',
      );
      const username = usernamesByUserId.get(createdByUserId);
      if (!username || row.username !== username) {
        throw new Error(
          'SQLITE_SOURCE_REFERENCE_MISSING:DailyReport.createdByUserId',
        );
      }
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
          responsiblePersonId,
          responsiblePersonSnapshot: sourceString(
            row.responsiblePersonSnapshot,
            'DailyReport.responsiblePersonSnapshot',
          ),
          startMinuteOfDay: sourceMinute(row.startMinuteOfDay),
          endMinuteOfDay: sourceMinute(row.endMinuteOfDay),
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
          submittedAt: normalizeLegacySubmittedAt(row.updatedAt),
          legacySubmittedByUsername: username,
        },
      };
    });
    return { shifts, responsiblePersons, appSetting, reports };
  } finally {
    database.close();
  }
}

function reportKeyConflicts(reports: LegacyDailyReport[]): MigrationConflict[] {
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
  return conflicts;
}

export async function createMigrationBundle(
  sqlitePath: string,
  uploadsPath: string,
): Promise<MigrationBundle> {
  const source = readSource(sqlitePath);
  const conflicts = reportKeyConflicts(source.reports);
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
    conflicts,
  });
  if (conflicts.length > 0) {
    throw new MigrationReportKeyConflictError(conflicts, sourceSummary);
  }
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

function pathsOverlap(left: string, right: string): boolean {
  return isInside(left, right) || isInside(right, left);
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

interface PathIdentity {
  canonicalPath: string;
  device: bigint;
  inode: bigint;
}

interface OutputSafetyContext {
  outputPath: string;
  outputParent: PathIdentity;
  sqliteSource: PathIdentity;
  uploadsSource: PathIdentity;
  repositoryRoot: string;
}

export interface DryRunSafetyHooks {
  beforeOutputWrite?(context: { outputParent: string }): void | Promise<void>;
  beforeOutputCommit?(context: { outputParent: string }): void | Promise<void>;
}

function pathIdentity(path: string, kind: 'file' | 'directory'): PathIdentity {
  const declaredPath = resolve(path);
  const stat = lstatSync(declaredPath, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    (kind === 'file' ? !stat.isFile() : !stat.isDirectory())
  ) {
    throw new Error('MIGRATION_SOURCE_NOT_CANONICAL');
  }
  return {
    canonicalPath: realpathSync(declaredPath),
    device: stat.dev,
    inode: stat.ino,
  };
}

function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function assertOutputDoesNotOverlap(
  outputPath: string,
  sqliteSource: PathIdentity,
  uploadsSource: PathIdentity,
  repositoryRoot: string,
): void {
  if (
    repositoryBoundaries(repositoryRoot).some((boundary) =>
      pathsOverlap(boundary, outputPath),
    )
  ) {
    throw new Error('MIGRATION_OUTPUT_INSIDE_REPOSITORY');
  }
  if (
    pathsOverlap(sqliteSource.canonicalPath, outputPath) ||
    pathsOverlap(uploadsSource.canonicalPath, outputPath)
  ) {
    throw new Error('MIGRATION_OUTPUT_SOURCE_OVERLAP');
  }
}

function createOutputSafetyContext(
  parsed: CliArguments,
  repositoryRoot: string,
): OutputSafetyContext {
  const outputPath = canonicalFuturePath(parsed.outputPath);
  if (
    repositoryBoundaries(repositoryRoot).some((boundary) =>
      pathsOverlap(boundary, outputPath),
    )
  ) {
    throw new Error('MIGRATION_OUTPUT_INSIDE_REPOSITORY');
  }
  const sqliteSource = pathIdentity(parsed.sqlitePath, 'file');
  const uploadsSource = pathIdentity(parsed.uploadsPath, 'directory');
  if (pathsOverlap(sqliteSource.canonicalPath, uploadsSource.canonicalPath)) {
    throw new Error('MIGRATION_SOURCE_OVERLAP');
  }
  assertOutputDoesNotOverlap(
    outputPath,
    sqliteSource,
    uploadsSource,
    repositoryRoot,
  );
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
  return {
    outputPath,
    outputParent: pathIdentity(dirname(outputPath), 'directory'),
    sqliteSource,
    uploadsSource,
    repositoryRoot,
  };
}

function assertOutputSafety(context: OutputSafetyContext): void {
  let currentParent: PathIdentity;
  let declaredParent: PathIdentity;
  let currentSqlite: PathIdentity;
  let currentUploads: PathIdentity;
  try {
    currentParent = pathIdentity(
      context.outputParent.canonicalPath,
      'directory',
    );
    declaredParent = pathIdentity(dirname(context.outputPath), 'directory');
    currentSqlite = pathIdentity(context.sqliteSource.canonicalPath, 'file');
    currentUploads = pathIdentity(
      context.uploadsSource.canonicalPath,
      'directory',
    );
  } catch {
    throw new Error('MIGRATION_OUTPUT_PATH_CHANGED');
  }
  if (
    !samePathIdentity(currentParent, context.outputParent) ||
    !samePathIdentity(declaredParent, context.outputParent) ||
    !samePathIdentity(currentSqlite, context.sqliteSource) ||
    !samePathIdentity(currentUploads, context.uploadsSource) ||
    canonicalFuturePath(context.outputPath) !== context.outputPath
  ) {
    throw new Error('MIGRATION_OUTPUT_PATH_CHANGED');
  }
  assertOutputDoesNotOverlap(
    context.outputPath,
    currentSqlite,
    currentUploads,
    context.repositoryRoot,
  );
  try {
    lstatSync(context.outputPath);
    throw new Error('MIGRATION_OUTPUT_ALREADY_EXISTS');
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'MIGRATION_OUTPUT_ALREADY_EXISTS'
    ) {
      throw error;
    }
  }
}

export async function runDryRunCli(
  args: string[],
  repositoryRoot = resolve(__dirname, '../../../..'),
  hooks: DryRunSafetyHooks = {},
): Promise<void> {
  const parsed = parseCliArguments(args);
  const safety = createOutputSafetyContext(parsed, repositoryRoot);

  let bundle: MigrationBundle | undefined;
  let summary: MigrationSummary;
  let terminalError: MigrationReportKeyConflictError | undefined;
  try {
    bundle = await createMigrationBundle(parsed.sqlitePath, parsed.uploadsPath);
    summary = bundle.sourceSummary;
  } catch (error) {
    if (!(error instanceof MigrationReportKeyConflictError)) throw error;
    summary = error.summary;
    terminalError = error;
  }
  const temporaryOutput = mkdtempSync(join(tmpdir(), 'fsk-migration-output-'));
  try {
    const temporaryIdentity = pathIdentity(temporaryOutput, 'directory');
    assertOutputDoesNotOverlap(
      temporaryIdentity.canonicalPath,
      safety.sqliteSource,
      safety.uploadsSource,
      repositoryRoot,
    );
    await hooks.beforeOutputWrite?.({
      outputParent: safety.outputParent.canonicalPath,
    });
    assertOutputSafety(safety);
    if (bundle) {
      writeFileSync(
        join(temporaryOutput, 'migration-bundle.json'),
        serializeMigrationBundle(bundle),
        { mode: 0o600, flag: 'wx' },
      );
    }
    writeFileSync(
      join(temporaryOutput, 'migration-report.json'),
      serializeMigrationReport(summary),
      { mode: 0o600, flag: 'wx' },
    );
    await hooks.beforeOutputCommit?.({
      outputParent: safety.outputParent.canonicalPath,
    });
    assertOutputSafety(safety);
    if (
      !samePathIdentity(
        pathIdentity(temporaryOutput, 'directory'),
        temporaryIdentity,
      )
    ) {
      throw new Error('MIGRATION_OUTPUT_PATH_CHANGED');
    }
    renameSync(temporaryOutput, safety.outputPath);
    if (terminalError) throw terminalError;
  } catch (error) {
    if (!terminalError || error !== terminalError) {
      rmSync(temporaryOutput, { recursive: true, force: true });
    }
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
