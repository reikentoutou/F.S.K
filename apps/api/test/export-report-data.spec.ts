import { describe, expect, it } from 'vitest';
import {
  aggregateGrandTotalsFromRows,
  byShiftSummaryPairs,
  formatByShiftSummaryValue,
  grandTotalPairs,
  shiftDetailPairs,
  type ExportReportRow,
} from '../src/export/export-report-data';

function row(overrides: Partial<ExportReportRow> = {}): ExportReportRow {
  return {
    reportDate: '2026-08-23',
    shiftNameSnapshot: '白班',
    responsiblePersonSnapshot: '厨房',
    timeRangeLabelSnapshot: '09:00 - 18:00',
    previousImosBalanceYen: 10_000,
    currentImosBalanceYen: 32_000,
    imosSalesYen: 22_000,
    newageYen: 8_000,
    cashTotalYen: 20_000,
    expenseYen: 1_000,
    expenseReason: '備品',
    staffMealCashYen: 1_200,
    staffMealAlipayYen: 800,
    totalSalesYen: 21_800,
    cashDepositYen: 15_000,
    createdBy: { username: 'kitchen' },
    ...overrides,
  };
}

describe('staff meal export data', () => {
  it('preserves detail order and uses the stored cash deposit', () => {
    expect(shiftDetailPairs(row(), 4_000)).toEqual([
      ['日付', '2026-08-23'],
      ['シフト', '白班'],
      ['責任者', '厨房'],
      ['Newage時間', '09:00 - 18:00'],
      ['前期Imos残高', '10000 円'],
      ['現在Imos残高', '32000 円'],
      ['Imos売上合計', '22000 円'],
      ['Newage売上', '8000 円'],
      ['お手元残高', '20000 円'],
      ['レジ底銭（設定）', '4000 円'],
      ['支出', '1000 円'],
      ['支出理由', '備品'],
      ['网管餐費（現金）', '1200 円'],
      ['网管餐費（支付宝）', '800 円'],
      ['网管餐費合計', '2000 円'],
      ['実際売上', '21800 円'],
      ['現金入金金額', '15000 円'],
      ['偏差', '800 円'],
      ['提出者', 'kitchen'],
    ]);
  });

  it('preserves total order and aggregates stored values', () => {
    const totals = aggregateGrandTotalsFromRows([
      row(),
      row({
        staffMealCashYen: 300,
        staffMealAlipayYen: 500,
        totalSalesYen: 10_000,
        imosSalesYen: 9_000,
        expenseYen: 0,
        cashDepositYen: 7_000,
      }),
    ]);
    expect(totals).toEqual({
      imosSalesYen: 31_000,
      newageYen: 16_000,
      cashDepositYen: 22_000,
      expenseYen: 1_000,
      staffMealCashYen: 1_500,
      staffMealAlipayYen: 1_300,
      staffMealTotalYen: 2_800,
      totalSalesYen: 31_800,
      deviationYen: 1_800,
    });
    expect(grandTotalPairs(totals)).toEqual([
      ['Imos売上合計', '31000 円'],
      ['Newage売上', '16000 円'],
      ['現金入金金額', '22000 円'],
      ['支出', '1000 円'],
      ['网管餐費（現金）', '1500 円'],
      ['网管餐費（支付宝）', '1300 円'],
      ['网管餐費合計', '2800 円'],
      ['実際売上', '31800 円'],
      ['偏差', '1800 円'],
    ]);
  });

  it('keeps shift summary values numeric in the existing field order', () => {
    expect(
      byShiftSummaryPairs({
        count: 2,
        imosSalesYen: 31_000,
        totalSalesYen: 31_800,
        cashDepositYen: 25_000,
        expenseYen: 1_000,
        deviationYen: 1_800,
        staffMealCashYen: 1_500,
        staffMealAlipayYen: 1_300,
        staffMealTotalYen: 2_800,
      }),
    ).toEqual([
      ['件数', 2],
      ['Imos売上合計', 31_000],
      ['実際売上', 31_800],
      ['現金入金金額', 25_000],
      ['支出', 1_000],
      ['网管餐費（現金）', 1_500],
      ['网管餐費（支付宝）', 1_300],
      ['网管餐費合計', 2_800],
      ['偏差', 1_800],
    ]);
  });

  it('formats shift money for HTML without adding a unit to the count', () => {
    expect(formatByShiftSummaryValue('件数', 2)).toBe('2');
    expect(formatByShiftSummaryValue('网管餐費合計', 2_800)).toBe('2800 円');
  });
});
