export const MAX_YEN = 2_000_000_000;

export interface DailyReportRawAmounts {
  previousImosBalanceYen: number;
  currentImosBalanceYen: number;
  newageYen: number;
  cashTotalYen: number;
  expenseYen: number;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
}

export interface DailyReportTotals {
  imosSalesYen: number;
  cashDepositYen: number;
  totalSalesYen: number;
  deviationYen: number;
  staffMealTotalYen: number;
}

type LegacyDailyReportRawAmounts = Omit<
  DailyReportRawAmounts,
  'staffMealCashYen' | 'staffMealAlipayYen'
> & {
  registerFloatYen: number;
  staffMealCashYen?: number;
};

type LegacyDailyReportTotals = Omit<DailyReportTotals, 'staffMealTotalYen'>;

const rawAmountFields: Array<keyof DailyReportRawAmounts> = [
  'previousImosBalanceYen',
  'currentImosBalanceYen',
  'newageYen',
  'cashTotalYen',
  'expenseYen',
  'staffMealCashYen',
  'staffMealAlipayYen',
];

function assertYenAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_YEN) {
    throw new Error('INVALID_DAILY_REPORT_AMOUNT');
  }
}

function isBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function dailyReportKey(businessDate: string, shiftId: string): string {
  if (!isBusinessDate(businessDate)) {
    throw new Error('INVALID_BUSINESS_DATE');
  }
  if (!shiftId || shiftId.includes('#')) {
    throw new Error('INVALID_SHIFT_ID');
  }
  return `${businessDate}#${shiftId}`;
}

export function assertDailyReportRawAmounts(
  value: DailyReportRawAmounts,
): void {
  for (const field of rawAmountFields) {
    assertYenAmount(value[field]);
  }
}

export function imosSalesYen(
  previousImosBalanceYen: number,
  currentImosBalanceYen: number,
): number {
  return currentImosBalanceYen - previousImosBalanceYen;
}

export function cashDepositYen(
  cashTotalYen: number,
  registerFloatYen: number,
): number {
  return cashTotalYen - registerFloatYen;
}

export function staffMealTotalYen(
  staffMealCashYen: number,
  staffMealAlipayYen: number,
): number {
  return staffMealCashYen + staffMealAlipayYen;
}

export function actualSalesYen(
  newageYen: number,
  cashTotalYen: number,
  registerFloatYen: number,
  staffMealCashYen = 0,
): number {
  return (
    newageYen +
    cashDepositYen(cashTotalYen, registerFloatYen) -
    staffMealCashYen
  );
}

export function deviationYen(
  actualSales: number,
  expenseYen: number,
  imosSales: number,
): number {
  return actualSales + expenseYen - imosSales;
}

export function computeDailyReportTotals(
  value: DailyReportRawAmounts,
  registerFloatYen: number,
): DailyReportTotals;
export function computeDailyReportTotals(
  value: LegacyDailyReportRawAmounts,
): LegacyDailyReportTotals;
export function computeDailyReportTotals(
  value: DailyReportRawAmounts | LegacyDailyReportRawAmounts,
  registerFloatYen?: number,
): DailyReportTotals | LegacyDailyReportTotals {
  const isLegacyCall = registerFloatYen === undefined;
  let rawAmounts: DailyReportRawAmounts;
  let effectiveRegisterFloatYen: number;
  if (isLegacyCall) {
    const legacyValue = value as LegacyDailyReportRawAmounts;
    rawAmounts = {
      ...legacyValue,
      staffMealCashYen: legacyValue.staffMealCashYen ?? 0,
      staffMealAlipayYen: 0,
    };
    effectiveRegisterFloatYen = legacyValue.registerFloatYen;
  } else {
    rawAmounts = value as DailyReportRawAmounts;
    effectiveRegisterFloatYen = registerFloatYen;
  }

  assertDailyReportRawAmounts(rawAmounts);
  assertYenAmount(effectiveRegisterFloatYen);

  const imosSalesYen =
    rawAmounts.currentImosBalanceYen - rawAmounts.previousImosBalanceYen;
  const cashDepositYen = rawAmounts.cashTotalYen - effectiveRegisterFloatYen;
  const totalSalesYen =
    rawAmounts.newageYen + cashDepositYen - rawAmounts.staffMealCashYen;
  const totals: DailyReportTotals = {
    imosSalesYen,
    cashDepositYen,
    totalSalesYen,
    deviationYen: totalSalesYen + rawAmounts.expenseYen - imosSalesYen,
    staffMealTotalYen:
      rawAmounts.staffMealCashYen + rawAmounts.staffMealAlipayYen,
  };

  if (isLegacyCall) {
    const { staffMealTotalYen: _staffMealTotalYen, ...legacyTotals } = totals;
    return legacyTotals;
  }
  return totals;
}

export function deviationYenFromStoredFields(row: {
  totalSalesYen: number;
  expenseYen: number;
  imosSalesYen: number;
}): number {
  return deviationYen(row.totalSalesYen, row.expenseYen, row.imosSalesYen);
}
