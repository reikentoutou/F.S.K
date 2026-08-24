import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
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
  status: unknown;
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

const MIN_TARGET_DATE_EPOCH_MS = -62_135_596_800_000;
const MAX_TARGET_DATE_EPOCH_MS = 253_402_300_799_999;
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
    year >= 1 &&
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
    value >= MIN_TARGET_DATE_EPOCH_MS &&
    value <= MAX_TARGET_DATE_EPOCH_MS
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
  const epochMilliseconds = parsed.getTime();
  if (
    Number.isNaN(epochMilliseconds) ||
    epochMilliseconds < MIN_TARGET_DATE_EPOCH_MS ||
    epochMilliseconds > MAX_TARGET_DATE_EPOCH_MS
  ) {
    throw new Error('INVALID_SQLITE_SOURCE_FIELD:DailyReport.updatedAt');
  }
  return parsed.toISOString();
}

function normalizeExpenseReason(value: unknown, expenseYen: number): string | null {
  if (value !== null && typeof value !== 'string') {
    throw new Error('INVALID_SQLITE_SOURCE_FIELD:DailyReport.expenseReason');
  }
  const normalized = value?.trim() || null;
  if (expenseYen > 0 && normalized === null) {
    throw new Error('INVALID_SQLITE_SOURCE_FIELD:DailyReport.expenseReason');
  }
  return normalized;
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
        report."staffMealAlipayYen", report."status", report."createdByUserId",
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
      if (row.status !== 'approved') {
        throw new Error('INVALID_SQLITE_SOURCE_FIELD:DailyReport.status');
      }
      const startMinuteOfDay = sourceMinute(row.startMinuteOfDay);
      const endMinuteOfDay = sourceMinute(row.endMinuteOfDay);
      if (startMinuteOfDay === endMinuteOfDay) {
        throw new Error('INVALID_SQLITE_SOURCE_FIELD:DailyReport.timeRange');
      }
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
          startMinuteOfDay,
          endMinuteOfDay,
          timeRangeLabelSnapshot: sourceString(
            row.timeRangeLabelSnapshot,
            'DailyReport.timeRangeLabelSnapshot',
          ),
          ...raw,
          expenseReason: normalizeExpenseReason(
            row.expenseReason,
            raw.expenseYen,
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
  const uploadInventory = await inventoryUploads(
    uploadsPath,
    source.reports.map((report) => ({
      legacyReportId: report.sourceId,
      reportKey: report.record.reportKey,
    })),
  );
  const attachments = uploadInventory.targetAttachments;
  const dailyReports = source.reports.map(({ record }) => ({
    ...record,
    attachmentKeys: attachments
      .filter((entry) => entry.reportKey === record.reportKey)
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
    sourceFiles: uploadInventory.sourceFiles,
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
    sqlitePath: resolve(values.get('--sqlite')!),
    uploadsPath: resolve(values.get('--uploads')!),
    outputPath: resolve(values.get('--out')!),
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
  beforeAnchoredFileWrite?(context: {
    outputParent: string;
  }): void | Promise<void>;
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

interface HeldOutputFile {
  name: string;
  fd: number;
  device: bigint;
  inode: bigint;
}

interface AnchoredOutput {
  originalCwd: string;
  outputName: string;
  directory: PathIdentity;
  directoryFd: number;
  report: HeldOutputFile;
  status: HeldOutputFile;
  bundle?: HeldOutputFile;
}

function sameDeviceAndInode(
  left: { dev: bigint; ino: bigint },
  right: { device: bigint; inode: bigint },
): boolean {
  return left.dev === right.device && left.ino === right.inode;
}

function openHeldOutputFile(name: string): HeldOutputFile {
  const fd = openSync(
    name,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || stat.size !== 0n) {
    closeSync(fd);
    throw new Error('MIGRATION_OUTPUT_ANCHOR_FAILED');
  }
  return { name, fd, device: stat.dev, inode: stat.ino };
}

function closeHeldOutputFile(file: HeldOutputFile | undefined): void {
  if (!file) return;
  try {
    closeSync(file.fd);
  } catch {
    // Preserve the primary migration result or failure.
  }
}

function createAnchoredOutput(context: OutputSafetyContext): AnchoredOutput {
  const originalCwd = process.cwd();
  const outputName = basename(context.outputPath);
  let createdDirectory = false;
  let enteredDirectory = false;
  let directoryFd: number | undefined;
  let report: HeldOutputFile | undefined;
  let status: HeldOutputFile | undefined;
  try {
    process.chdir(context.outputParent.canonicalPath);
    const parentStat = lstatSync('.', { bigint: true });
    if (
      !parentStat.isDirectory() ||
      !sameDeviceAndInode(parentStat, context.outputParent)
    ) {
      throw new Error('MIGRATION_OUTPUT_PATH_CHANGED');
    }
    mkdirSync(outputName, { mode: 0o700 });
    createdDirectory = true;
    process.chdir(outputName);
    enteredDirectory = true;
    const directory = pathIdentity('.', 'directory');
    if (directory.canonicalPath !== context.outputPath) {
      throw new Error('MIGRATION_OUTPUT_PATH_CHANGED');
    }
    assertOutputDoesNotOverlap(
      directory.canonicalPath,
      context.sqliteSource,
      context.uploadsSource,
      context.repositoryRoot,
    );
    directoryFd = openSync(
      '.',
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    report = openHeldOutputFile('migration-report.json');
    status = openHeldOutputFile('migration-status.json');
    replaceHeldOutputFile(
      status,
      `${JSON.stringify({ status: 'in-progress', errorCode: null }, null, 2)}\n`,
    );
    return {
      originalCwd,
      outputName,
      directory,
      directoryFd,
      report,
      status,
    };
  } catch (error) {
    closeHeldOutputFile(report);
    closeHeldOutputFile(status);
    if (directoryFd !== undefined) closeSync(directoryFd);
    try {
      if (enteredDirectory) {
        for (const name of ['migration-report.json', 'migration-status.json']) {
          try {
            unlinkSync(name);
          } catch {
            // Best-effort cleanup within the anchored directory.
          }
        }
        process.chdir('..');
      }
      if (createdDirectory) rmdirSync(outputName);
    } catch {
      // A safely isolated empty orphan is preferable to path-based cleanup.
    } finally {
      process.chdir(originalCwd);
    }
    throw error;
  }
}

function assertCurrentOutputAnchor(anchor: AnchoredOutput): void {
  const current = lstatSync('.', { bigint: true });
  const held = fstatSync(anchor.directoryFd, { bigint: true });
  if (
    !current.isDirectory() ||
    !held.isDirectory() ||
    current.dev !== held.dev ||
    current.ino !== held.ino ||
    !sameDeviceAndInode(held, anchor.directory)
  ) {
    throw new Error('MIGRATION_OUTPUT_ANCHOR_CHANGED');
  }
}

function writeHeldOutputFile(file: HeldOutputFile, content: string): void {
  const before = fstatSync(file.fd, { bigint: true });
  if (!before.isFile() || !sameDeviceAndInode(before, file)) {
    throw new Error('MIGRATION_OUTPUT_ANCHOR_CHANGED');
  }
  writeFileSync(file.fd, content, { encoding: 'utf8' });
  fsyncSync(file.fd);
  const after = fstatSync(file.fd, { bigint: true });
  if (!after.isFile() || !sameDeviceAndInode(after, file)) {
    throw new Error('MIGRATION_OUTPUT_ANCHOR_CHANGED');
  }
}

function replaceHeldOutputFile(file: HeldOutputFile, content: string): void {
  const before = fstatSync(file.fd, { bigint: true });
  if (!before.isFile() || !sameDeviceAndInode(before, file)) {
    throw new Error('MIGRATION_OUTPUT_ANCHOR_CHANGED');
  }
  const bytes = Buffer.from(content, 'utf8');
  ftruncateSync(file.fd, 0);
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += writeSync(
      file.fd,
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
  }
  fsyncSync(file.fd);
  const after = fstatSync(file.fd, { bigint: true });
  if (
    !after.isFile() ||
    !sameDeviceAndInode(after, file) ||
    after.size !== BigInt(bytes.byteLength)
  ) {
    throw new Error('MIGRATION_OUTPUT_ANCHOR_CHANGED');
  }
}

function assertHeldFilePath(file: HeldOutputFile): void {
  const stat = lstatSync(file.name, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    !sameDeviceAndInode(stat, file)
  ) {
    throw new Error('MIGRATION_OUTPUT_PATH_CHANGED');
  }
}

function assertAnchoredOutputStillDeclared(
  context: OutputSafetyContext,
  anchor: AnchoredOutput,
): void {
  let declaredDirectory: PathIdentity;
  let declaredParent: PathIdentity;
  let currentSqlite: PathIdentity;
  let currentUploads: PathIdentity;
  try {
    assertCurrentOutputAnchor(anchor);
    declaredDirectory = pathIdentity(context.outputPath, 'directory');
    declaredParent = pathIdentity(dirname(context.outputPath), 'directory');
    currentSqlite = pathIdentity(context.sqliteSource.canonicalPath, 'file');
    currentUploads = pathIdentity(
      context.uploadsSource.canonicalPath,
      'directory',
    );
    assertHeldFilePath(anchor.report);
    assertHeldFilePath(anchor.status);
    if (anchor.bundle) assertHeldFilePath(anchor.bundle);
  } catch {
    throw new Error('MIGRATION_OUTPUT_PATH_CHANGED');
  }
  if (
    !samePathIdentity(declaredDirectory, anchor.directory) ||
    !samePathIdentity(declaredParent, context.outputParent) ||
    !samePathIdentity(currentSqlite, context.sqliteSource) ||
    !samePathIdentity(currentUploads, context.uploadsSource)
  ) {
    throw new Error('MIGRATION_OUTPUT_PATH_CHANGED');
  }
  assertOutputDoesNotOverlap(
    declaredDirectory.canonicalPath,
    currentSqlite,
    currentUploads,
    context.repositoryRoot,
  );
}

function closeAnchoredOutput(anchor: AnchoredOutput): void {
  closeHeldOutputFile(anchor.bundle);
  closeHeldOutputFile(anchor.report);
  closeHeldOutputFile(anchor.status);
  try {
    closeSync(anchor.directoryFd);
  } catch {
    // Preserve the primary migration result or failure.
  }
  process.chdir(anchor.originalCwd);
}

function cleanupAnchoredOutput(anchor: AnchoredOutput): void {
  for (const file of [anchor.bundle, anchor.report, anchor.status]) {
    if (!file) continue;
    try {
      unlinkSync(file.name);
    } catch {
      // Do not follow a changed external pathname during cleanup.
    }
  }
  try {
    fsyncSync(anchor.directoryFd);
  } catch {
    // Cleanup is best effort after a terminal failure.
  }
  closeHeldOutputFile(anchor.bundle);
  closeHeldOutputFile(anchor.report);
  closeHeldOutputFile(anchor.status);
  try {
    closeSync(anchor.directoryFd);
  } catch {
    // Continue restoring cwd; the migration is already terminal.
  }
  try {
    process.chdir('..');
    const child = lstatSync(anchor.outputName, { bigint: true });
    if (
      child.isDirectory() &&
      !child.isSymbolicLink() &&
      sameDeviceAndInode(child, anchor.directory)
    ) {
      rmdirSync(anchor.outputName);
    }
  } catch {
    // A safely isolated orphan is allowed if its anchored identity changed.
  } finally {
    process.chdir(anchor.originalCwd);
  }
}

export async function runDryRunCli(
  args: string[],
  repositoryRoot = resolve(__dirname, '../../../..'),
  hooks: DryRunSafetyHooks = {},
): Promise<void> {
  const parsed = parseCliArguments(args);
  const safety = createOutputSafetyContext(parsed, repositoryRoot);
  const anchor = createAnchoredOutput(safety);
  let preserveOutput = false;
  let bundle: MigrationBundle | undefined;
  let summary: MigrationSummary;
  let terminalError: MigrationReportKeyConflictError | undefined;
  try {
    await hooks.beforeOutputWrite?.({
      outputParent: safety.outputParent.canonicalPath,
    });
    assertCurrentOutputAnchor(anchor);
    try {
      bundle = await createMigrationBundle(parsed.sqlitePath, parsed.uploadsPath);
      summary = bundle.sourceSummary;
    } catch (error) {
      if (!(error instanceof MigrationReportKeyConflictError)) throw error;
      summary = error.summary;
      terminalError = error;
    }
    await hooks.beforeOutputCommit?.({
      outputParent: safety.outputParent.canonicalPath,
    });
    assertCurrentOutputAnchor(anchor);
    if (bundle) {
      anchor.bundle = openHeldOutputFile('migration-bundle.json');
    }
    await hooks.beforeAnchoredFileWrite?.({
      outputParent: safety.outputParent.canonicalPath,
    });
    if (bundle && anchor.bundle) {
      writeHeldOutputFile(anchor.bundle, serializeMigrationBundle(bundle));
    }
    writeHeldOutputFile(anchor.report, serializeMigrationReport(summary));
    fsyncSync(anchor.directoryFd);
    assertAnchoredOutputStillDeclared(safety, anchor);
    replaceHeldOutputFile(
      anchor.status,
      `${JSON.stringify({
        status: terminalError ? 'conflict' : 'complete',
        errorCode: terminalError?.code ?? null,
      }, null, 2)}\n`,
    );
    fsyncSync(anchor.directoryFd);
    preserveOutput = true;
  } catch (error) {
    try {
      replaceHeldOutputFile(
        anchor.status,
        `${JSON.stringify({
          status: 'aborted',
          errorCode: error instanceof Error ? error.message : 'MIGRATION_FAILED',
        }, null, 2)}\n`,
      );
      fsyncSync(anchor.directoryFd);
    } catch {
      // The thrown error remains authoritative if even the held status FD fails.
    }
    throw error;
  } finally {
    if (preserveOutput) closeAnchoredOutput(anchor);
    else cleanupAnchoredOutput(anchor);
  }
  if (terminalError) throw terminalError;
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
