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

export function buildReportAnalytics(
  reports: readonly AnalyticsReport[],
  registerFloatYen: number,
  shiftSortOrders: ReadonlyMap<string, number>,
): ReportAnalytics {
  const rows = reports
    .map((report): CalculatedAnalyticsReport => {
      const totals = computeDailyReportTotals(report, registerFloatYen);
      return {
        ...report,
        registerFloatYen,
        ...totals,
      };
    })
    .sort((left, right) => compareReportRows(left, right, shiftSortOrders));

  const totals = emptyAggregate();
  const shifts = new Map<
    string,
    ShiftReportAggregate & {
      sortOrder: number | undefined;
      firstBusinessDate: string;
      firstStartMinuteOfDay: number;
    }
  >();

  for (const row of rows) {
    addReport(totals, row);
    let aggregate = shifts.get(row.shiftId);
    if (!aggregate) {
      aggregate = {
        shiftId: row.shiftId,
        shiftName: row.shiftNameSnapshot,
        sortOrder: shiftSortOrders.get(row.shiftId),
        firstBusinessDate: row.businessDate,
        firstStartMinuteOfDay: row.startMinuteOfDay,
        ...emptyAggregate(),
      };
      shifts.set(row.shiftId, aggregate);
    }
    addReport(aggregate, row);
  }

  const byShift = [...shifts.values()]
    .sort(compareShiftAggregates)
    .map(
      ({
        sortOrder: _sortOrder,
        firstBusinessDate: _firstBusinessDate,
        firstStartMinuteOfDay: _firstStartMinuteOfDay,
        ...aggregate
      }) => aggregate,
    );

  return { totals, byShift, rows };
}

function compareOptionalSortOrder(
  left: number | undefined,
  right: number | undefined,
): number {
  if (left !== undefined && right !== undefined) return left - right;
  if (left !== undefined) return -1;
  if (right !== undefined) return 1;
  return 0;
}

function compareReportRows(
  left: CalculatedAnalyticsReport,
  right: CalculatedAnalyticsReport,
  shiftSortOrders: ReadonlyMap<string, number>,
): number {
  return (
    left.businessDate.localeCompare(right.businessDate) ||
    compareOptionalSortOrder(
      shiftSortOrders.get(left.shiftId),
      shiftSortOrders.get(right.shiftId),
    ) ||
    left.startMinuteOfDay - right.startMinuteOfDay ||
    left.shiftId.localeCompare(right.shiftId) ||
    left.reportKey.localeCompare(right.reportKey)
  );
}

function compareShiftAggregates(
  left: ShiftReportAggregate & {
    sortOrder: number | undefined;
    firstBusinessDate: string;
    firstStartMinuteOfDay: number;
  },
  right: ShiftReportAggregate & {
    sortOrder: number | undefined;
    firstBusinessDate: string;
    firstStartMinuteOfDay: number;
  },
): number {
  return (
    compareOptionalSortOrder(left.sortOrder, right.sortOrder) ||
    left.firstBusinessDate.localeCompare(right.firstBusinessDate) ||
    left.firstStartMinuteOfDay - right.firstStartMinuteOfDay ||
    left.shiftId.localeCompare(right.shiftId)
  );
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
