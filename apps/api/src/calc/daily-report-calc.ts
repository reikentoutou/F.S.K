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

export function actualSalesYen(
  newageYen: number,
  cashTotalYen: number,
  registerFloatYen: number,
): number {
  return newageYen + cashDepositYen(cashTotalYen, registerFloatYen);
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
