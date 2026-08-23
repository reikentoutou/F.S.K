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

export function computeDailyReportTotals(data: {
  previousImosBalanceYen: number;
  currentImosBalanceYen: number;
  newageYen: number;
  cashTotalYen: number;
  expenseYen: number;
  registerFloatYen: number;
  staffMealCashYen?: number;
}) {
  const imosSales = imosSalesYen(
    data.previousImosBalanceYen,
    data.currentImosBalanceYen,
  );
  const cashDeposit = cashDepositYen(data.cashTotalYen, data.registerFloatYen);
  const actualSales = actualSalesYen(
    data.newageYen,
    data.cashTotalYen,
    data.registerFloatYen,
    data.staffMealCashYen ?? 0,
  );
  return {
    imosSalesYen: imosSales,
    totalSalesYen: actualSales,
    cashDepositYen: cashDeposit,
    deviationYen: deviationYen(actualSales, data.expenseYen, imosSales),
  };
}

export function deviationYenFromStoredFields(row: {
  totalSalesYen: number;
  expenseYen: number;
  imosSalesYen: number;
}): number {
  return deviationYen(row.totalSalesYen, row.expenseYen, row.imosSalesYen);
}
