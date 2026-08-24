import {
  computeDailyReportTotals,
  type DailyReportRawAmounts,
} from '@fsk/domain';
import { DateTime } from 'luxon';

export type AnalyticsPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface AnalyticsReport extends DailyReportRawAmounts {
  reportKey: string;
  businessDate: string;
  shiftId: string;
  shiftNameSnapshot: string;
  responsiblePersonSnapshot: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  timeRangeLabelSnapshot: string;
  expenseReason?: string | null;
}

export interface CalculatedAnalyticsReport extends AnalyticsReport {
  registerFloatYen: number;
  durationMinutes: number;
  imosSalesYen: number;
  cashDepositYen: number;
  totalSalesYen: number;
  deviationYen: number;
  staffMealTotalYen: number;
}

export interface ReportAggregate {
  count: number;
  imosSalesYen: number;
  cashDepositYen: number;
  totalSalesYen: number;
  expenseYen: number;
  deviationYen: number;
  staffMealCashYen: number;
  staffMealAlipayYen: number;
  staffMealTotalYen: number;
}

export interface ShiftReportAggregate extends ReportAggregate {
  shiftId: string;
  shiftName: string;
}

export interface ReportAnalytics {
  totals: ReportAggregate;
  byShift: ShiftReportAggregate[];
  rows: CalculatedAnalyticsReport[];
}

function emptyAggregate(): ReportAggregate {
  return {
    count: 0,
    imosSalesYen: 0,
    cashDepositYen: 0,
    totalSalesYen: 0,
    expenseYen: 0,
    deviationYen: 0,
    staffMealCashYen: 0,
    staffMealAlipayYen: 0,
    staffMealTotalYen: 0,
  };
}

function addReport(
  aggregate: ReportAggregate,
  report: CalculatedAnalyticsReport,
): void {
  aggregate.count += 1;
  aggregate.imosSalesYen += report.imosSalesYen;
  aggregate.cashDepositYen += report.cashDepositYen;
  aggregate.totalSalesYen += report.totalSalesYen;
  aggregate.expenseYen += report.expenseYen;
  aggregate.deviationYen += report.deviationYen;
  aggregate.staffMealCashYen += report.staffMealCashYen;
  aggregate.staffMealAlipayYen += report.staffMealAlipayYen;
  aggregate.staffMealTotalYen += report.staffMealTotalYen;
}

function durationMinutes(start: number, end: number): number {
  return end >= start ? end - start : 24 * 60 - start + end;
}

export function buildReportAnalytics(
  reports: readonly AnalyticsReport[],
  registerFloatYen: number,
): ReportAnalytics {
  const rows = reports
    .map((report): CalculatedAnalyticsReport => {
      const totals = computeDailyReportTotals(report, registerFloatYen);
      return {
        ...report,
        registerFloatYen,
        durationMinutes: durationMinutes(
          report.startMinuteOfDay,
          report.endMinuteOfDay,
        ),
        ...totals,
      };
    })
    .sort(
      (left, right) =>
        left.businessDate.localeCompare(right.businessDate) ||
        left.startMinuteOfDay - right.startMinuteOfDay ||
        left.shiftId.localeCompare(right.shiftId),
    );

  const totals = emptyAggregate();
  const shifts = new Map<
    string,
    ShiftReportAggregate & { firstStartMinuteOfDay: number }
  >();

  for (const row of rows) {
    addReport(totals, row);
    let aggregate = shifts.get(row.shiftId);
    if (!aggregate) {
      aggregate = {
        shiftId: row.shiftId,
        shiftName: row.shiftNameSnapshot,
        firstStartMinuteOfDay: row.startMinuteOfDay,
        ...emptyAggregate(),
      };
      shifts.set(row.shiftId, aggregate);
    }
    aggregate.firstStartMinuteOfDay = Math.min(
      aggregate.firstStartMinuteOfDay,
      row.startMinuteOfDay,
    );
    addReport(aggregate, row);
  }

  const byShift = [...shifts.values()]
    .sort(
      (left, right) =>
        left.firstStartMinuteOfDay - right.firstStartMinuteOfDay ||
        left.shiftId.localeCompare(right.shiftId),
    )
    .map(({ firstStartMinuteOfDay: _firstStartMinuteOfDay, ...aggregate }) =>
      aggregate,
    );

  return { totals, byShift, rows };
}

export function actualSalesBarData(
  byShift: readonly ShiftReportAggregate[],
): {
  categories: string[];
  series: Array<{ name: string; data: number[] }>;
} {
  return {
    categories: byShift.map((shift) => shift.shiftName),
    series: [
      {
        name: '実際売上',
        data: byShift.map((shift) => shift.totalSalesYen),
      },
    ],
  };
}

function parseAnchorDate(anchorDate: string): DateTime {
  const anchor = DateTime.fromISO(anchorDate, { zone: 'Asia/Tokyo' });
  if (!anchor.isValid || anchor.toISODate() !== anchorDate) {
    throw new Error('ANALYTICS_ANCHOR_DATE_INVALID');
  }
  return anchor.startOf('day');
}

export function tokyoPeriodRange(
  period: AnalyticsPeriod,
  anchorDate: string,
): { start: string; end: string } {
  const anchor = parseAnchorDate(anchorDate);
  let start: DateTime;
  let end: DateTime;

  switch (period) {
    case 'day':
      start = anchor;
      end = anchor;
      break;
    case 'week':
      start = anchor.startOf('week');
      end = start.plus({ days: 6 });
      break;
    case 'month':
      start = anchor.startOf('month');
      end = anchor.endOf('month');
      break;
    case 'quarter': {
      const startMonth = Math.floor((anchor.month - 1) / 3) * 3 + 1;
      start = anchor.set({ month: startMonth, day: 1 }).startOf('day');
      end = start.plus({ months: 3 }).minus({ days: 1 });
      break;
    }
    case 'year':
      start = anchor.startOf('year');
      end = anchor.endOf('year');
      break;
  }

  return { start: start.toISODate()!, end: end.toISODate()! };
}
