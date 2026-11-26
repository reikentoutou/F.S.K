import { describe, expect, it } from 'vitest';
import { prepareKitchenReport } from './handler.js';
const claims = { 'cognito:groups': ['KITCHEN'], 'cognito:username': 'store02', sub: 'subject-02' };
const context = { registerFloatAmount: 30000, shifts: [{ id: '02_day', name: '早班', sortOrder: 1 }], responsiblePersons: [{ id: '02_person', name: '甲' }], submittedShiftIds: [] };
const input = { storeId: '02', businessDate: '2026-11-26', shiftId: '02_day', responsiblePersonId: '02_person', startMinuteOfDay: 540, endMinuteOfDay: 1080, previousImosBalanceYen: 0, currentImosBalanceYen: 10000, newageYen: 0, cashTotalYen: 40000, expenseYen: 0, staffMealCashYen: 0, staffMealAlipayYen: 0, attachmentKeys: [] };
const now = new Date('2026-11-26T01:00:00Z');

describe('trusted kitchen submission', () => {
  it('uses authoritative store, people, float, identity and timestamp', () => {
    const result = prepareKitchenReport({ ...input, owner: 'forged', registerFloatSnapshot: 0, shiftNameSnapshot: 'forged' }, claims, context, now);
    expect(result).toMatchObject({ storeId: '02', reportKey: '02#2026-11-26#02_day', registerFloatSnapshot: 30000, shiftNameSnapshot: '早班', responsiblePersonSnapshot: '甲', owner: 'subject-02::store02', submittedAt: now.toISOString() });
  });
  it('rejects forged stores and foreign shift/person identifiers', () => {
    expect(() => prepareKitchenReport({ ...input, storeId: '03' }, claims, context, now)).toThrow('STORE_FORBIDDEN');
    expect(() => prepareKitchenReport({ ...input, shiftId: '03_day' }, claims, context, now)).toThrow();
    expect(() => prepareKitchenReport({ ...input, responsiblePersonId: '03_person' }, claims, context, now)).toThrow();
  });
  it('rejects invalid amounts, dates, times and expenses without receipts', () => {
    for (const patch of [{ cashTotalYen: -1 }, { newageYen: 0.5 }, { businessDate: '2026-11-27' }, { startMinuteOfDay: 1440 }, { expenseYen: 10 }]) {
      expect(() => prepareKitchenReport({ ...input, ...patch }, claims, context, now)).toThrow();
    }
  });
  it('returns a conflict for an already submitted shift', () => {
    expect(() => prepareKitchenReport(input, claims, { ...context, submittedShiftIds: ['02_day'] }, now)).toThrow('REPORT_ALREADY_EXISTS');
  });
});
