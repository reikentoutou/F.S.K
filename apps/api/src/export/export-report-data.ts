import {
  deviationYenFromStoredFields,
  staffMealTotalYen,
} from '../calc/daily-report-calc';

export type ExportReportRow = {
  reportDate: string;
  shiftNameSnapshot: string;
  responsiblePersonSnapshot: string;
  timeRangeLabelSnapshot: string;
  previousImosBalanceYen: number;
  currentImosBalanceYen: number;
  imosSalesYen: number;
  newageYen: number;
  cashTotalYen: number;
  expenseYen: number;
  expenseReason: string | null;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  totalSalesYen: number;
  cashDepositYen: number;
  createdBy: { username: string };
};

export type GrandTotalsAgg = {
  imosSalesYen: number;
  newageYen: number;
  cashDepositYen: number;
  expenseYen: number;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  staffMealTotalYen: number;
  totalSalesYen: number;
  deviationYen: number;
};

export type ByShiftExportSummary = {
  count: number;
  imosSalesYen: number;
  totalSalesYen: number;
  cashDepositYen: number;
  expenseYen: number;
  deviationYen: number;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  staffMealTotalYen: number;
};

export type ExportPair = [string, string | number];

export function aggregateGrandTotalsFromRows(
  rows: ExportReportRow[],
): GrandTotalsAgg {
  const totals: GrandTotalsAgg = {
    imosSalesYen: 0,
    newageYen: 0,
    cashDepositYen: 0,
    expenseYen: 0,
    staffMealCashYen: 0,
    staffMealAlipayYen: 0,
    staffMealTotalYen: 0,
    totalSalesYen: 0,
    deviationYen: 0,
  };
  for (const row of rows) {
    totals.imosSalesYen += row.imosSalesYen;
    totals.newageYen += row.newageYen;
    totals.cashDepositYen += row.cashDepositYen;
    totals.expenseYen += row.expenseYen;
    totals.staffMealCashYen += row.staffMealCashYen;
    totals.staffMealAlipayYen += row.staffMealAlipayYen;
    totals.staffMealTotalYen += staffMealTotalYen(
      row.staffMealCashYen,
      row.staffMealAlipayYen,
    );
    totals.totalSalesYen += row.totalSalesYen;
    totals.deviationYen += deviationYenFromStoredFields(row);
  }
  return totals;
}

export function grandTotalPairs(t: GrandTotalsAgg): ExportPair[] {
  return [
    ['Imos売上合計', `${t.imosSalesYen} 円`],
    ['Newage売上', `${t.newageYen} 円`],
    ['現金入金金額', `${t.cashDepositYen} 円`],
    ['支出', `${t.expenseYen} 円`],
    ['网管餐費（現金）', `${t.staffMealCashYen} 円`],
    ['网管餐費（支付宝）', `${t.staffMealAlipayYen} 円`],
    ['网管餐費合計', `${t.staffMealTotalYen} 円`],
    ['実際売上', `${t.totalSalesYen} 円`],
    ['偏差', `${t.deviationYen} 円`],
  ];
}

export function byShiftSummaryPairs(b: ByShiftExportSummary): ExportPair[] {
  return [
    ['件数', b.count],
    ['Imos売上合計', b.imosSalesYen],
    ['実際売上', b.totalSalesYen],
    ['現金入金金額', b.cashDepositYen],
    ['支出', b.expenseYen],
    ['网管餐費（現金）', b.staffMealCashYen],
    ['网管餐費（支付宝）', b.staffMealAlipayYen],
    ['网管餐費合計', b.staffMealTotalYen],
    ['偏差', b.deviationYen],
  ];
}

export function formatByShiftSummaryValue(
  label: string,
  value: string | number,
): string {
  return label === '件数' ? String(value) : `${value} 円`;
}

export function shiftDetailPairs(
  r: ExportReportRow,
  registerFloat: number,
): ExportPair[] {
  return [
    ['日付', r.reportDate],
    ['シフト', r.shiftNameSnapshot],
    ['責任者', r.responsiblePersonSnapshot],
    ['Newage時間', r.timeRangeLabelSnapshot],
    ['前期Imos残高', `${r.previousImosBalanceYen} 円`],
    ['現在Imos残高', `${r.currentImosBalanceYen} 円`],
    ['Imos売上合計', `${r.imosSalesYen} 円`],
    ['Newage売上', `${r.newageYen} 円`],
    ['お手元残高', `${r.cashTotalYen} 円`],
    ['レジ底銭（設定）', `${registerFloat} 円`],
    ['支出', `${r.expenseYen} 円`],
    ['支出理由', r.expenseReason?.trim() || '—'],
    ['网管餐費（現金）', `${r.staffMealCashYen} 円`],
    ['网管餐費（支付宝）', `${r.staffMealAlipayYen} 円`],
    [
      '网管餐費合計',
      `${staffMealTotalYen(r.staffMealCashYen, r.staffMealAlipayYen)} 円`,
    ],
    ['実際売上', `${r.totalSalesYen} 円`],
    ['現金入金金額', `${r.cashDepositYen} 円`],
    ['偏差', `${deviationYenFromStoredFields(r)} 円`],
    ['提出者', r.createdBy.username],
  ];
}
