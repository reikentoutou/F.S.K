import {
  computeDailyReportTotals,
  type DailyReportRawAmounts,
  type DailyReportTotals,
} from '@fsk/domain';
import type {
  AppSettingRecord,
  AttachmentManifestEntry,
  DailyReportRecord,
  MigrationSummary,
  MigrationWarning,
} from './contracts';

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

function zeroRawAmounts(): DailyReportRawAmounts {
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

function zeroDerivedAmounts(): DailyReportTotals {
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
    if (!Number.isSafeInteger(sum)) throw new Error('MIGRATION_SUM_OVERFLOW');
    target[field] = sum;
  }
}

function addDerived(
  target: DailyReportTotals,
  source: DailyReportTotals,
): void {
  for (const field of derivedFields) {
    const sum = target[field] + source[field];
    if (!Number.isSafeInteger(sum)) throw new Error('MIGRATION_SUM_OVERFLOW');
    target[field] = sum;
  }
}

export function buildMigrationSummary(input: {
  shiftCount: number;
  responsiblePersonCount: number;
  appSetting: AppSettingRecord;
  reports: DailyReportRecord[];
  attachments: AttachmentManifestEntry[];
  warnings: MigrationWarning[];
}): MigrationSummary {
  const global = { raw: zeroRawAmounts(), derived: zeroDerivedAmounts() };
  const byBusinessDate: MigrationSummary['amounts']['byBusinessDate'] = {};
  for (const report of input.reports) {
    const raw: DailyReportRawAmounts = {
      previousImosBalanceYen: report.previousImosBalanceYen,
      currentImosBalanceYen: report.currentImosBalanceYen,
      newageYen: report.newageYen,
      cashTotalYen: report.cashTotalYen,
      expenseYen: report.expenseYen,
      staffMealCashYen: report.staffMealCashYen,
      staffMealAlipayYen: report.staffMealAlipayYen,
    };
    const derived = computeDailyReportTotals(
      raw,
      input.appSetting.registerFloatAmount,
    );
    const daily = (byBusinessDate[report.businessDate] ??= {
      raw: zeroRawAmounts(),
      derived: zeroDerivedAmounts(),
    });
    addRaw(daily.raw, raw);
    addDerived(daily.derived, derived);
    addRaw(global.raw, raw);
    addDerived(global.derived, derived);
  }

  return {
    modelCounts: {
      shifts: input.shiftCount,
      responsiblePersons: input.responsiblePersonCount,
      appSettings: 1,
      dailyReports: input.reports.length,
      attachments: input.attachments.length,
    },
    amounts: { byBusinessDate, global },
    attachmentSummary: {
      count: input.attachments.length,
      totalBytes: input.attachments.reduce((sum, entry) => {
        const next = sum + entry.byteSize;
        if (!Number.isSafeInteger(next)) throw new Error('MIGRATION_SUM_OVERFLOW');
        return next;
      }, 0),
      hashes: input.attachments.map(({ objectKey, sha256 }) => ({
        objectKey,
        sha256,
      })),
    },
    warnings: input.warnings,
    conflicts: [],
    orphans: input.attachments
      .filter((entry) => entry.orphan)
      .map((entry) => entry.objectKey),
  };
}

export function serializeMigrationReport(summary: MigrationSummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}
