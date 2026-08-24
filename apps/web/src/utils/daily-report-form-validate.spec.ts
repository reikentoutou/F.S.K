import { describe, expect, it } from 'vitest';
import {
  MAX_DAILY_REPORT_AMOUNT_YEN,
  validateDailyReportGoToConfirm,
  validateDailyReportSubmit,
} from './daily-report-form-validate';

type ValidationForm = Parameters<
  typeof validateDailyReportSubmit
>[0]['form'];

function form(overrides: Partial<ValidationForm> = {}): ValidationForm {
  return {
    responsiblePersonId: 'person-1',
    startStr: '09:00',
    endStr: '18:00',
    previousImosBalanceYen: 10_000,
    currentImosBalanceYen: 20_000,
    newageYen: 8_000,
    cashInDrawerYen: 20_000,
    expenseYen: 0,
    expenseReason: '',
    expenseReceiptStored: true,
    staffMealCashYen: 0,
    staffMealAlipayYen: 0,
    ...overrides,
  };
}

describe('daily report staff meal validation', () => {
  it('accepts integer bounds in both validation stages', () => {
    const valid = form({
      staffMealCashYen: 0,
      staffMealAlipayYen: MAX_DAILY_REPORT_AMOUNT_YEN,
    });
    expect(validateDailyReportGoToConfirm({ form: valid })).toBeNull();
    expect(validateDailyReportSubmit({ form: valid })).toBeNull();
  });

  it.each([-1, 1.5, 2_000_000_001, Number.NaN])(
    'rejects invalid staff meal cash %s before confirmation and submit',
    (value) => {
      const invalid = form({ staffMealCashYen: value });
      expect(validateDailyReportGoToConfirm({ form: invalid })).toBe(
        '网管餐費は0〜2,000,000,000円の整数で入力してください',
      );
      expect(validateDailyReportSubmit({ form: invalid })).toBe(
        '网管餐費は0〜2,000,000,000円の整数で入力してください',
      );
    },
  );

  it('rejects invalid Alipay amount', () => {
    expect(
      validateDailyReportSubmit({
        form: form({ staffMealAlipayYen: 2_000_000_001 }),
      }),
    ).toBe('网管餐費は0〜2,000,000,000円の整数で入力してください');
  });

  it.each([
    'previousImosBalanceYen',
    'currentImosBalanceYen',
    'newageYen',
    'cashInDrawerYen',
    'expenseYen',
  ] as const)('enforces the shared yen maximum for %s', (field) => {
    const invalid = form({
      [field]: MAX_DAILY_REPORT_AMOUNT_YEN + 1,
      expenseReason: '消耗品',
    });

    expect(validateDailyReportGoToConfirm({ form: invalid })).toBe(
      '金額は0〜2,000,000,000円の整数で入力してください',
    );
    expect(validateDailyReportSubmit({ form: invalid })).toBe(
      '金額は0〜2,000,000,000円の整数で入力してください',
    );
  });
});
