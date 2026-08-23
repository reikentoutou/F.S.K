import { describe, expect, it } from 'vitest';
import {
  aggregateGrandTotalsFromRows,
  byShiftSummaryPairs,
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
  it('puts raw methods and derived total into every report detail', () => {
    expect(shiftDetailPairs(row(), 5_000)).toEqual(
      expect.arrayContaining([
        ['网管餐費（現金）', '1200 円'],
        ['网管餐費（支付宝）', '800 円'],
        ['网管餐費合計', '2000 円'],
        ['実際売上', '21800 円'],
      ]),
    );
  });

  it('aggregates both payment methods without changing stored actual sales', () => {
    const totals = aggregateGrandTotalsFromRows([
      row(),
      row({
        staffMealCashYen: 300,
        staffMealAlipayYen: 500,
        totalSalesYen: 10_000,
        imosSalesYen: 9_000,
        expenseYen: 0,
      }),
    ]);
    expect(totals).toMatchObject({
      staffMealCashYen: 1_500,
      staffMealAlipayYen: 1_300,
      staffMealTotalYen: 2_800,
      totalSalesYen: 31_800,
    });
    expect(grandTotalPairs(totals)).toEqual(
      expect.arrayContaining([
        ['网管餐費（現金）', '1500 円'],
        ['网管餐費（支付宝）', '1300 円'],
        ['网管餐費合計', '2800 円'],
      ]),
    );
  });

  it('adds all three values to each shift summary', () => {
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
    ).toEqual(
      expect.arrayContaining([
        ['网管餐費（現金）', '1500 円'],
        ['网管餐費（支付宝）', '1300 円'],
        ['网管餐費合計', '2800 円'],
      ]),
    );
  });
});
