import { lstatSync, realpathSync } from 'node:fs';
import { fork } from 'node:child_process';
import {
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
  UploadInventory,
} from './contracts';
import { buildMigrationSummary, serializeMigrationReport } from './report';
import {
  spawnWorkerClient,
  type WorkerClient,
  type WorkerClientOptions,
  type WorkerClientProcess,
  type WorkerEnvelope,
} from './worker-client';

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

interface LegacySourceSnapshot {
  shifts: ShiftDefinitionRecord[];
  responsiblePersons: ResponsiblePersonRecord[];
  appSetting: AppSettingRecord;
  reports: LegacyDailyReport[];
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

function readSource(sqlitePath: string): LegacySourceSnapshot {
  const declaredPath = resolve(sqlitePath);
  const sourceStat = lstatSync(declaredPath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error('SQLITE_SOURCE_NOT_CANONICAL');
  }
  const canonicalPath = realpathSync(declaredPath);
  const database = new DatabaseSync(canonicalPath, { readOnly: true });
  try {
    database.exec('PRAGMA query_only = ON');
    database.exec('BEGIN');
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
    try {
      database.exec('ROLLBACK');
    } catch {
      // A failed source read remains authoritative.
    }
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

function bundleFromSource(
  source: LegacySourceSnapshot,
  uploadInventory: UploadInventory,
): MigrationBundle {
  const conflicts = reportKeyConflicts(source.reports);
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

export async function createMigrationBundle(
  sqlitePath: string,
  uploadsPath: string,
  workerOptions: Partial<WorkerClientOptions> = {},
): Promise<MigrationBundle> {
  const sqliteSource = pathIdentity(sqlitePath, 'file');
  const uploadsSource = pathIdentity(uploadsPath, 'directory');
  const source = readSource(sqlitePath);
  const session = await startInventoryWorker(
    uploadsSource,
    source.reports.map((report) => ({
      legacyReportId: report.sourceId,
      reportKey: report.record.reportKey,
    })),
    resolveWorkerOptions(workerOptions),
  );
  try {
    const uploadInventory = await session.collect();
    const currentSqlite = pathIdentity(sqliteSource.canonicalPath, 'file');
    const currentUploads = pathIdentity(
      uploadsSource.canonicalPath,
      'directory',
    );
    if (
      !samePathIdentity(currentSqlite, sqliteSource) ||
      !samePathIdentity(currentUploads, uploadsSource)
    ) {
      throw new Error('MIGRATION_SOURCE_CHANGED');
    }
    return bundleFromSource(source, uploadInventory);
  } finally {
    await session.close();
  }
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
  afterSourcesBound?(): void | Promise<void>;
  beforeSourceIdentityEvidence?(): void | Promise<void>;
  beforeWorkerFileWrite?(context: {
    fileKind: OutputFileKind;
    stagingFilePath: string;
  }): void | Promise<void>;
  afterWorkerFileWrite?(context: {
    fileKind: OutputFileKind;
    stagingFilePath: string;
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

type OutputFileKind = 'bundle' | 'report' | 'status';

interface MigrationWorkerEnvelope extends WorkerEnvelope {
  errorCode?: string;
  stageName?: string;
  fileName?: string;
  fileKind?: OutputFileKind;
  device?: string;
  inode?: string;
  inventory?: UploadInventory;
}

interface InventoryWorkerSession {
  collect(): Promise<UploadInventory>;
  close(): Promise<void>;
}

interface OutputWorkerSession {
  stageName: string;
  write(
    files: Array<{ kind: OutputFileKind; name: string; content: string }>,
    hooks: DryRunSafetyHooks,
  ): Promise<PathIdentity>;
  accept(): Promise<void>;
  cleanup(): Promise<void>;
}

function workerScriptPath(): string {
  return resolve(__dirname, 'worker.ts');
}

function spawnWorker(
  mode: 'inventory' | 'output',
  cwd: string,
  args: string[],
  options: WorkerClientOptions,
): WorkerClient {
  return spawnWorkerClient(
    () =>
      fork(workerScriptPath(), [mode, ...args], {
        cwd,
        execArgv: ['--import', require.resolve('tsx')],
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      }) as WorkerClientProcess,
    options,
  );
}

const DEFAULT_WORKER_OPTIONS: WorkerClientOptions = {
  timeoutMs: 15 * 60 * 1_000,
  terminateGraceMs: 2_000,
};

function resolveWorkerOptions(
  options: Partial<WorkerClientOptions>,
): WorkerClientOptions {
  return { ...DEFAULT_WORKER_OPTIONS, ...options };
}

async function startInventoryWorker(
  uploadsSource: PathIdentity,
  reportHints: Array<{ legacyReportId: string; reportKey: string }>,
  options: WorkerClientOptions,
): Promise<InventoryWorkerSession> {
  const client = spawnWorker('inventory', uploadsSource.canonicalPath, [
    uploadsSource.device.toString(),
    uploadsSource.inode.toString(),
  ], options);
  try {
    await client.waitFor(['ready']);
  } catch (error) {
    await client.terminateAndReap();
    throw error;
  }
  return {
    async collect() {
      const message = (await client.request(
        { type: 'inventory', reportHints },
        ['inventory'],
      )) as MigrationWorkerEnvelope;
      if (!message.inventory) throw new Error('MIGRATION_WORKER_RESULT_INVALID');
      return message.inventory;
    },
    close: () => client.terminateAndReap(),
  };
}

async function startOutputWorker(
  context: OutputSafetyContext,
  options: WorkerClientOptions,
): Promise<OutputWorkerSession> {
  const outputName = context.outputPath.slice(
    dirname(context.outputPath).length + 1,
  );
  const client = spawnWorker('output', context.outputParent.canonicalPath, [
    outputName,
    context.outputParent.device.toString(),
    context.outputParent.inode.toString(),
  ], options);
  let ready: MigrationWorkerEnvelope;
  try {
    ready = (await client.waitFor(['ready'])) as MigrationWorkerEnvelope;
  } catch (error) {
    await client.terminateAndReap();
    throw error;
  }
  if (!ready.stageName) {
    await client.terminateAndReap();
    throw new Error('MIGRATION_WORKER_RESULT_INVALID');
  }
  let materialized = false;
  let writeStarted = false;
  return {
    stageName: ready.stageName,
    async write(files, hooks) {
      writeStarted = true;
      let message = (await client.request(
        { type: 'write', files },
        ['beforeWrite', 'afterWrite', 'materialized'],
      )) as MigrationWorkerEnvelope;
      while (true) {
        if (message.type === 'materialized') {
          if (!message.device || !message.inode) {
            throw new Error('MIGRATION_WORKER_RESULT_INVALID');
          }
          materialized = true;
          return {
            canonicalPath: context.outputPath,
            device: BigInt(message.device),
            inode: BigInt(message.inode),
          };
        }
        if (!message.fileKind || !message.fileName) {
          throw new Error('MIGRATION_WORKER_RESULT_INVALID');
        }
        const stagingFilePath = join(
          context.outputParent.canonicalPath,
          ready.stageName!,
          message.fileName,
        );
        if (message.type === 'beforeWrite') {
          await hooks.beforeWorkerFileWrite?.({
            fileKind: message.fileKind,
            stagingFilePath,
          });
        } else {
          await hooks.afterWorkerFileWrite?.({
            fileKind: message.fileKind,
            stagingFilePath,
          });
        }
        message = (await client.request(
          { type: 'continue' },
          ['beforeWrite', 'afterWrite', 'materialized'],
        )) as MigrationWorkerEnvelope;
      }
    },
    async accept() {
      await client.request({ type: 'accept' }, ['accepted']);
      await client.waitForExit();
    },
    async cleanup() {
      try {
        if (materialized || !writeStarted) {
          await client.request({ type: 'cleanup' }, ['cleaned']);
          await client.waitForExit();
          return;
        }
      } catch {
        // A failed transport is reaped below; the worker owns safe cleanup.
      }
      await client.terminateAndReap();
    },
  };
}

function assertDeclaredIdentities(context: OutputSafetyContext): void {
  let parent: PathIdentity;
  let sqlite: PathIdentity;
  let uploads: PathIdentity;
  try {
    parent = pathIdentity(dirname(context.outputPath), 'directory');
    sqlite = pathIdentity(context.sqliteSource.canonicalPath, 'file');
    uploads = pathIdentity(context.uploadsSource.canonicalPath, 'directory');
  } catch {
    throw new Error('MIGRATION_OUTPUT_PATH_CHANGED');
  }
  if (
    !samePathIdentity(parent, context.outputParent) ||
    !samePathIdentity(sqlite, context.sqliteSource) ||
    !samePathIdentity(uploads, context.uploadsSource)
  ) {
    throw new Error('MIGRATION_OUTPUT_PATH_CHANGED');
  }
  assertOutputDoesNotOverlap(
    context.outputPath,
    sqlite,
    uploads,
    context.repositoryRoot,
  );
}

function assertPublishedOutput(
  context: OutputSafetyContext,
  published: PathIdentity,
): void {
  assertDeclaredIdentities(context);
  let declared: PathIdentity;
  try {
    declared = pathIdentity(context.outputPath, 'directory');
  } catch {
    throw new Error('MIGRATION_OUTPUT_PATH_CHANGED');
  }
  if (!samePathIdentity(declared, published)) {
    throw new Error('MIGRATION_OUTPUT_PATH_CHANGED');
  }
}

export async function runDryRunCli(
  args: string[],
  repositoryRoot = resolve(__dirname, '../../../..'),
  hooks: DryRunSafetyHooks = {},
  workerOptions: Partial<WorkerClientOptions> = {},
): Promise<void> {
  const parsed = parseCliArguments(args);
  const safety = createOutputSafetyContext(parsed, repositoryRoot);
  let source: LegacySourceSnapshot | undefined;
  let sourceError: Error | undefined;
  try {
    source = readSource(parsed.sqlitePath);
  } catch (error) {
    sourceError =
      error instanceof Error ? error : new Error('MIGRATION_SOURCE_READ_FAILED');
  }
  const reportHints =
    source?.reports.map((report) => ({
      legacyReportId: report.sourceId,
      reportKey: report.record.reportKey,
    })) ?? [];
  const inventorySessionPromise = source
    ? startInventoryWorker(
        safety.uploadsSource,
        reportHints,
        resolveWorkerOptions(workerOptions),
      )
    : undefined;
  const outputSessionPromise = startOutputWorker(
    safety,
    resolveWorkerOptions(workerOptions),
  );
  let inventorySession: InventoryWorkerSession | undefined;
  let outputSession: OutputWorkerSession | undefined;
  let outputAccepted = false;
  let bundle: MigrationBundle | undefined;
  let terminalError: MigrationReportKeyConflictError | undefined;
  try {
    const [inventoryResult, outputResult] = await Promise.allSettled([
      inventorySessionPromise,
      outputSessionPromise,
    ]);
    if (inventoryResult.status === 'fulfilled') {
      inventorySession = inventoryResult.value;
    }
    if (outputResult.status === 'fulfilled') {
      outputSession = outputResult.value;
    }
    if (inventoryResult.status === 'rejected') throw inventoryResult.reason;
    if (outputResult.status === 'rejected') throw outputResult.reason;
    if (!outputSession) throw new Error('MIGRATION_OUTPUT_WORKER_UNAVAILABLE');
    await hooks.beforeOutputWrite?.({
      outputParent: safety.outputParent.canonicalPath,
    });
    assertDeclaredIdentities(safety);
    if (sourceError) {
      const published = await outputSession.write(
        [
          {
            kind: 'status',
            name: 'migration-status.json',
            content: `${JSON.stringify(
              { status: 'aborted', errorCode: sourceError.message },
              null,
              2,
            )}\n`,
          },
        ],
        hooks,
      );
      assertPublishedOutput(safety, published);
      await outputSession.accept();
      outputAccepted = true;
      throw sourceError;
    }
    if (!source || !inventorySession) {
      throw new Error('MIGRATION_SOURCE_READ_FAILED');
    }
    await hooks.afterSourcesBound?.();
    const uploadInventory = await inventorySession.collect();
    await hooks.beforeSourceIdentityEvidence?.();
    assertDeclaredIdentities(safety);
    try {
      bundle = bundleFromSource(source, uploadInventory);
    } catch (error) {
      if (!(error instanceof MigrationReportKeyConflictError)) throw error;
      terminalError = error;
    }
    await hooks.beforeOutputCommit?.({
      outputParent: safety.outputParent.canonicalPath,
    });
    assertDeclaredIdentities(safety);
    await hooks.beforeAnchoredFileWrite?.({
      outputParent: safety.outputParent.canonicalPath,
    });
    assertDeclaredIdentities(safety);
    const summary = bundle?.sourceSummary ?? terminalError!.summary;
    const files: Array<{
      kind: OutputFileKind;
      name: string;
      content: string;
    }> = [];
    if (bundle) {
      files.push({
        kind: 'bundle',
        name: 'migration-bundle.json',
        content: serializeMigrationBundle(bundle),
      });
    }
    files.push({
      kind: 'report',
      name: 'migration-report.json',
      content: serializeMigrationReport(summary),
    });
    files.push({
      kind: 'status',
      name: 'migration-status.json',
      content: `${JSON.stringify(
        {
          status: terminalError ? 'conflict' : 'complete',
          errorCode: terminalError?.code ?? null,
        },
        null,
        2,
      )}\n`,
    });
    const published = await outputSession.write(files, hooks);
    assertPublishedOutput(safety, published);
    await outputSession.accept();
    outputAccepted = true;
  } finally {
    if (inventorySession) await inventorySession.close();
    if (outputSession && !outputAccepted) await outputSession.cleanup();
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
