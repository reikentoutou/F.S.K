import {
  computeDailyReportTotals,
  type DailyReportRawAmounts,
  type DailyReportTotals,
} from '@fsk/domain';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  DailyReportRecord,
  MigrationBundle,
  MigrationSummary,
} from './contracts';
import {
  assertExplicitTargetConfiguration,
  amplifyDataTargetRecord,
  createAwsMigrationTarget,
  type MigrationModelName,
  type MigrationTarget,
  type TargetConfiguration,
} from './target';

const rawFields: Array<keyof DailyReportRawAmounts> = [
  'previousImosBalanceYen',
  'currentImosBalanceYen',
  'newageYen',
  'cashTotalYen',
  'expenseYen',
  'staffMealCashYen',
  'staffMealAlipayYen',
];
const derivedFields: Array<keyof DailyReportTotals> = [
  'imosSalesYen',
  'cashDepositYen',
  'totalSalesYen',
  'deviationYen',
  'staffMealTotalYen',
];

function zeroRaw(): DailyReportRawAmounts {
  return {
    previousImosBalanceYen: 0,
    currentImosBalanceYen: 0,
    newageYen: 0,
    cashTotalYen: 0,
    expenseYen: 0,
    staffMealCashYen: 0,
    staffMealAlipayYen: 0,
  };
}

function zeroDerived(): DailyReportTotals {
  return {
    imosSalesYen: 0,
    cashDepositYen: 0,
    totalSalesYen: 0,
    deviationYen: 0,
    staffMealTotalYen: 0,
  };
}

function addRaw(
  target: DailyReportRawAmounts,
  source: DailyReportRawAmounts,
): void {
  for (const field of rawFields) {
    const sum = target[field] + source[field];
    if (!Number.isSafeInteger(sum)) throw new Error('TARGET_VERIFICATION_SUM_OVERFLOW');
    target[field] = sum;
  }
}

function addDerived(
  target: DailyReportTotals,
  source: DailyReportTotals,
): void {
  for (const field of derivedFields) {
    const sum = target[field] + source[field];
    if (!Number.isSafeInteger(sum)) throw new Error('TARGET_VERIFICATION_SUM_OVERFLOW');
    target[field] = sum;
  }
}

function rawFromRecord(record: Record<string, unknown>): DailyReportRawAmounts {
  const raw = Object.fromEntries(
    rawFields.map((field) => {
      const value = record[field];
      if (!Number.isSafeInteger(value)) {
        throw new Error(`TARGET_VERIFICATION_RECORD_INVALID:${field}`);
      }
      return [field, value];
    }),
  );
  return raw as unknown as DailyReportRawAmounts;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stable(record[key])]),
    );
  }
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function recordKey(model: MigrationModelName, record: Record<string, unknown>): string {
  const value = record[model === 'DailyReport' ? 'reportKey' : 'id'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`TARGET_VERIFICATION_KEY_INVALID:${model}`);
  }
  return value;
}

function assertExactRecords(
  model: MigrationModelName,
  actual: Record<string, unknown>[],
  expected: Record<string, unknown>[],
): void {
  const actualMap = new Map(actual.map((record) => [recordKey(model, record), record]));
  if (actualMap.size !== actual.length || actualMap.size !== expected.length) {
    throw new Error(`TARGET_VERIFICATION_MISMATCH:records:${model}`);
  }
  for (const record of expected) {
    const key = recordKey(model, record);
    if (!same(actualMap.get(key), record)) {
      throw new Error(`TARGET_VERIFICATION_MISMATCH:records:${model}`);
    }
  }
}

function calculateAmounts(
  reports: Record<string, unknown>[],
  registerFloatAmount: number,
): MigrationSummary['amounts'] {
  const global = { raw: zeroRaw(), derived: zeroDerived() };
  const byBusinessDate: MigrationSummary['amounts']['byBusinessDate'] = {};
  const sorted = [...reports].sort((left, right) =>
    String(left.reportKey).localeCompare(String(right.reportKey), 'en'),
  );
  for (const report of sorted) {
    if (typeof report.businessDate !== 'string') {
      throw new Error('TARGET_VERIFICATION_RECORD_INVALID:businessDate');
    }
    const raw = rawFromRecord(report);
    const derived = computeDailyReportTotals(raw, registerFloatAmount);
    const daily = (byBusinessDate[report.businessDate] ??= {
      raw: zeroRaw(),
      derived: zeroDerived(),
    });
    addRaw(daily.raw, raw);
    addDerived(daily.derived, derived);
    addRaw(global.raw, raw);
    addDerived(global.derived, derived);
  }
  return { byBusinessDate, global };
}

export async function verifyMigrationTarget(input: {
  bundle: MigrationBundle;
  target: MigrationTarget;
}): Promise<{
  status: 'verified';
  modelCounts: MigrationSummary['modelCounts'];
  amounts: MigrationSummary['amounts'];
  attachments: MigrationSummary['targetAttachmentSummary'];
}> {
  await input.target.assertSafeTarget();
  const expectedAttachmentObjectKeys = input.bundle.attachments
    .map((entry) => entry.objectKey);
  const expectedAttachmentObjectKeySet = new Set(expectedAttachmentObjectKeys);
  if (expectedAttachmentObjectKeySet.size !== expectedAttachmentObjectKeys.length) {
    throw new Error('TARGET_VERIFICATION_MISMATCH:attachmentKeys');
  }
  const [shifts, persons, settings, reports] = await Promise.all([
    input.target.listRecords('ShiftDefinition'),
    input.target.listRecords('ResponsiblePerson'),
    input.target.listRecords('AppSetting'),
    input.target.listRecords('DailyReport'),
    input.target.assertAttachmentObjectKeys(expectedAttachmentObjectKeySet),
  ]);
  const modelCounts = {
    shifts: shifts.length,
    responsiblePersons: persons.length,
    appSettings: settings.length,
    dailyReports: reports.length,
    attachments: expectedAttachmentObjectKeySet.size,
  };
  if (!same(modelCounts, input.bundle.sourceSummary.modelCounts)) {
    throw new Error('TARGET_VERIFICATION_MISMATCH:modelCounts');
  }
  if (
    settings.length !== 1 ||
    settings[0].id !== 'default' ||
    !Number.isSafeInteger(settings[0].registerFloatAmount)
  ) {
    throw new Error('TARGET_VERIFICATION_MISMATCH:AppSetting');
  }
  const amounts = calculateAmounts(reports, settings[0].registerFloatAmount as number);
  if (!same(amounts, input.bundle.sourceSummary.amounts)) {
    throw new Error('TARGET_VERIFICATION_MISMATCH:amounts');
  }

  assertExactRecords(
    'ShiftDefinition',
    shifts,
    input.bundle.shifts.map((record) =>
      amplifyDataTargetRecord('ShiftDefinition', { ...record }),
    ),
  );
  assertExactRecords(
    'ResponsiblePerson',
    persons,
    input.bundle.responsiblePersons.map((record) =>
      amplifyDataTargetRecord('ResponsiblePerson', { ...record }),
    ),
  );
  assertExactRecords('AppSetting', settings, [
    amplifyDataTargetRecord('AppSetting', { ...input.bundle.appSetting }),
  ]);
  assertExactRecords(
    'DailyReport',
    reports,
    input.bundle.dailyReports.map((record: DailyReportRecord) =>
      amplifyDataTargetRecord('DailyReport', { ...record }),
    ),
  );

  const hashes: Array<{ objectKey: string; sha256: string }> = [];
  let totalBytes = 0;
  for (const entry of [...input.bundle.attachments].sort((left, right) =>
    left.objectKey.localeCompare(right.objectKey, 'en'),
  )) {
    const object = await input.target.readAttachment(entry.objectKey);
    if (object.byteSize !== entry.byteSize || object.sha256 !== entry.sha256) {
      throw new Error(`TARGET_VERIFICATION_MISMATCH:attachment:${entry.objectKey}`);
    }
    totalBytes += object.byteSize;
    if (!Number.isSafeInteger(totalBytes)) throw new Error('TARGET_VERIFICATION_SUM_OVERFLOW');
    hashes.push({ objectKey: entry.objectKey, sha256: object.sha256 });
  }
  const attachments = {
    count: hashes.length,
    totalBytes,
    hashes,
  };
  const expectedAttachments = {
    ...input.bundle.sourceSummary.targetAttachmentSummary,
    hashes: [...input.bundle.sourceSummary.targetAttachmentSummary.hashes].sort((left, right) =>
      left.objectKey.localeCompare(right.objectKey, 'en'),
    ),
  };
  if (!same(attachments, expectedAttachments)) {
    throw new Error('TARGET_VERIFICATION_MISMATCH:attachments');
  }
  return { status: 'verified', modelCounts, amounts, attachments };
}

export interface VerifyCliOptions {
  mode: 'dry-run' | 'verify';
  bundlePath?: string;
  targetConfigPath?: string;
}

function cliArgumentValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`VERIFY_ARGUMENT_VALUE_REQUIRED:${flag}`);
  }
  return value;
}

export function parseVerifyCliOptions(argv: string[]): VerifyCliOptions {
  const valued = new Set(['--bundle', '--target-config']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valued.has(argument)) {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`VERIFY_ARGUMENT_VALUE_REQUIRED:${argument}`);
      }
    } else if (!['--verify', '--dry-run'].includes(argument)) {
      throw new Error(`VERIFY_ARGUMENT_UNKNOWN:${argument}`);
    }
  }
  const verify = argv.includes('--verify');
  if (verify && argv.includes('--dry-run')) throw new Error('VERIFY_MODE_CONFLICT');
  const bundlePath = cliArgumentValue(argv, '--bundle');
  const targetConfigPath = cliArgumentValue(argv, '--target-config');
  if (verify && !bundlePath) throw new Error('VERIFY_BUNDLE_REQUIRED');
  if (verify && !targetConfigPath) throw new Error('VERIFY_TARGET_CONFIG_REQUIRED');
  return {
    mode: verify ? 'verify' : 'dry-run',
    bundlePath,
    targetConfigPath,
  };
}

function readCliJson(path: string): unknown {
  if (!isAbsolute(path)) throw new Error('VERIFY_INPUT_PATH_NOT_ABSOLUTE');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('VERIFY_INPUT_PATH_INVALID');
  }
  return JSON.parse(readFileSync(realpathSync(path), 'utf8'));
}

export async function runVerifyCli(argv: string[]): Promise<unknown> {
  const options = parseVerifyCliOptions(argv);
  if (options.mode === 'dry-run') return { status: 'dry-run' };
  const bundle = readCliJson(options.bundlePath!) as MigrationBundle;
  const config = readCliJson(options.targetConfigPath!) as TargetConfiguration;
  assertExplicitTargetConfiguration(config);
  return verifyMigrationTarget({
    bundle,
    target: createAwsMigrationTarget(config),
  });
}

function verifyErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z0-9_:#.-]+$/u.test(error.message)) {
    return error.message.slice(0, 300);
  }
  return 'UNCLASSIFIED_VERIFY_FAILURE';
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runVerifyCli(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result)),
    (error: unknown) => {
      console.error(verifyErrorCode(error));
      process.exitCode = 1;
    },
  );
}
