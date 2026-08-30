import type { CalculatedAnalyticsReport } from '@/analytics/report-analytics';

export const REPORT_CSV_HEADERS = [
  '業務日',
  'シフト',
  '時間帯',
  '責任者',
  '前期Imos残高',
  '現在Imos残高',
  'Imos売上合計',
  'Newage売上',
  'お手元残高',
  '底銭',
  '現金入金金額',
  '支出',
  '支出理由',
  '网管餐費（現金）',
  '网管餐費（支付宝）',
  '网管餐費合計',
  '実際売上',
  '偏差',
] as const;

function protectFormula(value: string): string {
  return /^[\p{White_Space}\p{Cc}]*[=+\-@]/u.test(value)
    ? `'${value}`
    : value;
}

function csvCell(value: string | number | null | undefined): string {
  const text =
    typeof value === 'string'
      ? protectFormula(value)
      : value === null || value === undefined
        ? ''
        : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildReportCsv(
  reports: readonly CalculatedAnalyticsReport[],
): string {
  const records = reports.map((report) =>
    [
      report.businessDate,
      report.shiftNameSnapshot,
      report.timeRangeLabelSnapshot,
      report.responsiblePersonSnapshot,
      report.previousImosBalanceYen,
      report.currentImosBalanceYen,
      report.imosSalesYen,
      report.newageYen,
      report.cashTotalYen,
      report.registerFloatYen,
      report.cashDepositYen,
      report.expenseYen,
      report.expenseReason,
      report.staffMealCashYen,
      report.staffMealAlipayYen,
      report.staffMealTotalYen,
      report.totalSalesYen,
      report.deviationYen,
    ]
      .map(csvCell)
      .join(','),
  );

  return `\ufeff${[REPORT_CSV_HEADERS.join(','), ...records].join('\r\n')}\r\n`;
}

export function downloadCsvFile(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}
