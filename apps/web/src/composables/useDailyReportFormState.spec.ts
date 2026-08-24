import { describe, expect, it } from 'vitest';
import { useDailyReportFormState } from './useDailyReportFormState';

describe('useDailyReportFormState staff meals', () => {
  it('defaults, resets, and submits both fields', () => {
    const state = useDailyReportFormState();
    expect(state.form.staffMealCashYen).toBe(0);
    expect(state.form.staffMealAlipayYen).toBe(0);

    state.form.responsiblePersonId = 'person-1';
    state.form.staffMealCashYen = 1_200;
    state.form.staffMealAlipayYen = 800;
    expect(state.buildPayload('2026-08-23', 'shift-1')).toMatchObject({
      staffMealCashYen: 1_200,
      staffMealAlipayYen: 800,
    });

    state.reset();
    expect(state.form.staffMealCashYen).toBe(0);
    expect(state.form.staffMealAlipayYen).toBe(0);
  });

  it('loads old report-shaped data as zero when meal fields are absent', () => {
    const state = useDailyReportFormState();
    state.applyExisting({
      responsiblePersonId: 'person-1',
      startMinuteOfDay: 540,
      endMinuteOfDay: 1080,
      previousImosBalanceYen: 10_000,
      currentImosBalanceYen: 32_000,
      newageYen: 8_000,
      cashTotalYen: 20_000,
      expenseYen: 0,
      expenseReason: null,
    });
    expect(state.form.staffMealCashYen).toBe(0);
    expect(state.form.staffMealAlipayYen).toBe(0);
  });

  it('clears a stale responsible person when a kitchen route resets without a default', () => {
    const state = useDailyReportFormState();
    state.form.responsiblePersonId = 'removed-person';

    state.reset();

    expect(state.form.responsiblePersonId).toBe('');
  });
});
