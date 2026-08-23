import { describe, expect, it } from 'vitest';
import {
  actualSalesYen,
  cashDepositYen,
  computeDailyReportTotals,
  deviationYen,
  imosSalesYen,
  staffMealTotalYen,
} from '../src/calc/daily-report-calc';

describe('daily report calc with staff meals', () => {
  it('keeps staff meal cash inside cash deposit but removes it from actual sales', () => {
    expect(cashDepositYen(20_000, 5_000)).toBe(15_000);
    expect(actualSalesYen(8_000, 20_000, 5_000, 1_200)).toBe(21_800);
  });

  it('derives the staff meal total without storing it in report totals', () => {
    expect(staffMealTotalYen(1_200, 800)).toBe(2_000);
    expect(
      computeDailyReportTotals({
        previousImosBalanceYen: 10_000,
        currentImosBalanceYen: 32_000,
        newageYen: 8_000,
        cashTotalYen: 20_000,
        expenseYen: 1_000,
        registerFloatYen: 5_000,
        staffMealCashYen: 1_200,
      }),
    ).toEqual({
      imosSalesYen: 22_000,
      totalSalesYen: 21_800,
      cashDepositYen: 15_000,
      deviationYen: 800,
    });
  });

  it('preserves the previous result when staff meal cash is zero', () => {
    expect(actualSalesYen(8_000, 20_000, 5_000)).toBe(23_000);
    expect(imosSalesYen(10_000, 32_000)).toBe(22_000);
    expect(deviationYen(23_000, 1_000, 22_000)).toBe(2_000);
  });
});
