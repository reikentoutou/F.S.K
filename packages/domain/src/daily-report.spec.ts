import { describe, expect, it } from 'vitest';
import {
  MAX_YEN,
  assertDailyReportRawAmounts,
  computeDailyReportTotals,
  dailyReportKey,
  type DailyReportRawAmounts,
} from './daily-report';

function rawAmounts(
  overrides: Partial<DailyReportRawAmounts> = {},
): DailyReportRawAmounts {
  return {
    previousImosBalanceYen: 10_000,
    currentImosBalanceYen: 32_000,
    newageYen: 8_000,
    cashTotalYen: 20_000,
    expenseYen: 1_000,
    staffMealCashYen: 1_200,
    staffMealAlipayYen: 800,
    ...overrides,
  };
}

describe('daily report domain', () => {
  it('derives cash deposit, actual sales, deviation, and meal total from raw amounts', () => {
    expect(computeDailyReportTotals(rawAmounts(), 5_000)).toEqual({
      imosSalesYen: 22_000,
      cashDepositYen: 15_000,
      totalSalesYen: 21_800,
      deviationYen: 800,
      staffMealTotalYen: 2_000,
    });
  });

  it('does not include Alipay staff meals in actual sales', () => {
    expect(
      computeDailyReportTotals(
        rawAmounts({ staffMealAlipayYen: 20_000 }),
        5_000,
      ).totalSalesYen,
    ).toBe(21_800);
  });

  it('builds a deterministic business-date and shift key', () => {
    expect(dailyReportKey('2026-08-24', 'shift-day')).toBe(
      '2026-08-24#shift-day',
    );
  });

  it.each([
    [
      'invalid business date',
      () => dailyReportKey('2026-02-30', 'shift-day'),
      'INVALID_BUSINESS_DATE',
    ],
    ['empty shift', () => dailyReportKey('2026-08-24', ''), 'INVALID_SHIFT_ID'],
    [
      'shift containing separator',
      () => dailyReportKey('2026-08-24', 'shift#day'),
      'INVALID_SHIFT_ID',
    ],
  ])('rejects %s with a stable error code', (_name, invoke, errorCode) => {
    expect(invoke).toThrowError(errorCode);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_YEN + 1])(
    'rejects invalid raw and register amounts: %s',
    (invalidAmount) => {
      for (const field of Object.keys(rawAmounts()) as Array<
        keyof DailyReportRawAmounts
      >) {
        expect(() =>
          assertDailyReportRawAmounts(rawAmounts({ [field]: invalidAmount })),
        ).toThrowError('INVALID_DAILY_REPORT_AMOUNT');
      }
      expect(() =>
        computeDailyReportTotals(rawAmounts(), invalidAmount),
      ).toThrowError('INVALID_DAILY_REPORT_AMOUNT');
    },
  );

  it('accepts every raw amount and register float at the inclusive bounds', () => {
    expect(() =>
      assertDailyReportRawAmounts(
        rawAmounts({
          previousImosBalanceYen: 0,
          currentImosBalanceYen: MAX_YEN,
          newageYen: MAX_YEN,
          cashTotalYen: MAX_YEN,
          expenseYen: MAX_YEN,
          staffMealCashYen: MAX_YEN,
          staffMealAlipayYen: MAX_YEN,
        }),
      ),
    ).not.toThrow();
    expect(() => computeDailyReportTotals(rawAmounts(), MAX_YEN)).not.toThrow();
  });
});
