import { describe, expect, it } from 'vitest';
import {
  actualSalesYen,
  cashDepositYen,
  computeDailyReportTotals,
  deviationYen,
  imosSalesYen,
} from './daily-report-calc';

describe('daily report calc', () => {
  it('computes Imos sales from balances', () => {
    expect(imosSalesYen(10000, 13500)).toBe(3500);
  });

  it('computes cash deposit from cash balance and register float', () => {
    expect(cashDepositYen(20000, 5000)).toBe(15000);
  });

  it('computes actual sales', () => {
    expect(actualSalesYen(8000, 20000, 5000)).toBe(23000);
  });

  it('computes deviation', () => {
    expect(deviationYen(23000, 1000, 22000)).toBe(2000);
  });

  it('returns all stored totals', () => {
    expect(
      computeDailyReportTotals({
        previousImosBalanceYen: 10000,
        currentImosBalanceYen: 32000,
        newageYen: 8000,
        cashTotalYen: 20000,
        expenseYen: 1000,
        registerFloatYen: 5000,
      }),
    ).toEqual({
      imosSalesYen: 22000,
      totalSalesYen: 23000,
      cashDepositYen: 15000,
      deviationYen: 2000,
    });
  });
});
