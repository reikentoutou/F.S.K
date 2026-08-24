import { describe, expect, it } from 'vitest';
import {
  actualSalesYen,
  cashDepositYen,
  computeDailyReportTotals,
  deviationYen,
  imosSalesYen,
  staffMealTotalYen,
} from './daily-report-calc';

describe('daily report calc with staff meals', () => {
  it('computes Imos sales and cash deposit without changing cash deposit for meals', () => {
    expect(imosSalesYen(10_000, 32_000)).toBe(22_000);
    expect(cashDepositYen(20_000, 5_000)).toBe(15_000);
  });

  it('subtracts only staff meal cash from actual sales', () => {
    expect(actualSalesYen(8_000, 20_000, 5_000, 1_200)).toBe(21_800);
    expect(staffMealTotalYen(1_200, 800)).toBe(2_000);
  });

  it('returns only the stored server totals', () => {
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

  it('keeps old reports unchanged when both meal fields are zero', () => {
    expect(actualSalesYen(8_000, 20_000, 5_000)).toBe(23_000);
    expect(staffMealTotalYen(0, 0)).toBe(0);
    expect(deviationYen(23_000, 1_000, 22_000)).toBe(2_000);
    expect(
      computeDailyReportTotals({
        previousImosBalanceYen: 10_000,
        currentImosBalanceYen: 32_000,
        newageYen: 8_000,
        cashTotalYen: 20_000,
        expenseYen: 1_000,
        registerFloatYen: 5_000,
      }),
    ).toEqual({
      imosSalesYen: 22_000,
      totalSalesYen: 23_000,
      cashDepositYen: 15_000,
      deviationYen: 2_000,
    });
  });
});
