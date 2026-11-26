import { describe, expect, it } from 'vitest';
import { buildReportAnalytics, type AnalyticsReport } from './report-analytics';
import { buildReportCsv } from '../export/report-csv';
const report = { reportKey: '02#2026-11-26#02_day', businessDate: '2026-11-26', shiftId: '02_day', shiftNameSnapshot: '早班', responsiblePersonSnapshot: '甲', startMinuteOfDay: 0, endMinuteOfDay: 60, timeRangeLabelSnapshot: '00:00–01:00', previousImosBalanceYen: 0, currentImosBalanceYen: 10000, newageYen: 0, cashTotalYen: 40000, expenseYen: 0, staffMealCashYen: 0, staffMealAlipayYen: 0 };
describe('multi-store reporting', () => {
 it('uses each report float snapshot, including zero, instead of current global settings', () => {
   const rows = [{ ...report, storeId: '02', registerFloatSnapshot: 30000 }, { ...report, reportKey: '03#2026-11-26#03_day', shiftId: '03_day', storeId: '03', registerFloatSnapshot: 0 }];
   const result = buildReportAnalytics(rows as AnalyticsReport[], 99999, new Map());
   expect(result.totals.totalSalesYen).toBe(50000);
   expect(result.rows.map(r => r.registerFloatYen)).toEqual([30000, 0]);
   const csv = buildReportCsv(result.rows);
   expect(csv).toContain('店舗');
   expect(csv).toContain('2 店');
   expect(csv).toContain('3 店');
 });
});
