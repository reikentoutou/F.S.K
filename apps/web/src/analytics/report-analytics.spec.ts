// @vitest-environment jsdom

import { createApp, defineComponent, h, nextTick } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actualSalesBarData,
  buildReportAnalytics,
  tokyoPeriodRange,
  type AnalyticsReport,
  type ReportAggregate,
} from './report-analytics';
import { todayTokyo } from '@/utils/tokyo';
import * as analyticsView from '@/views/admin/AnalyticsView.vue';

const repositoryMocks = vi.hoisted(() => ({
  listByBusinessDate: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock('@/data/daily-reports', () => ({
  dailyReportsRepository: {
    listByBusinessDate: repositoryMocks.listByBusinessDate,
  },
}));

vi.mock('@/data/master-data', () => ({
  ownerMasterDataRepository: {
    getSetting: repositoryMocks.getSetting,
  },
}));

vi.mock('@/composables/useEchartsBarChart', () => ({
  useEchartsBarChart: () => ({
    setBarData: vi.fn(),
    resize: vi.fn(),
  }),
}));

interface AnalyticsLoader {
  loadOwnerAnalytics(options: {
    period: 'day' | 'week' | 'month' | 'quarter' | 'year';
    anchorDate: string;
    listByBusinessDate(date: string): Promise<Array<AnalyticsReport | null>>;
    getSetting(id: string): Promise<{ registerFloatAmount: number }>;
  }): Promise<{
    range: { start: string; end: string };
    registerFloatAmount: number;
    analytics: ReturnType<typeof buildReportAnalytics>;
  }>;
}

const viewLoader = analyticsView as unknown as AnalyticsLoader;

const Passthrough = defineComponent({
  props: { label: String },
  setup(props, { slots, attrs }) {
    return () =>
      h('div', attrs, [
        props.label ? h('strong', props.label) : null,
        slots.default?.(),
        slots.empty?.(),
      ]);
  },
});

const ButtonStub = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  setup(props, { slots, attrs }) {
    return () =>
      h(
        'button',
        {
          ...attrs,
          disabled: props.disabled || props.loading,
        },
        slots.default?.(),
      );
  },
});

const PeriodSelectStub = defineComponent({
  emits: ['update:modelValue'],
  setup(_props, { emit }) {
    return () =>
      h(
        'button',
        {
          'data-testid': 'period-change',
          onClick: () => emit('update:modelValue', 'day'),
        },
        '期間変更',
      );
  },
});

async function renderAnalyticsView(): Promise<HTMLElement> {
  const root = document.createElement('div');
  const app = createApp(analyticsView.default);
  for (const name of [
    'ElForm',
    'ElFormItem',
    'ElOption',
    'ElDatePicker',
    'ElDescriptions',
    'ElDescriptionsItem',
    'ElEmpty',
  ]) {
    app.component(name, Passthrough);
  }
  app.component('ElButton', ButtonStub);
  app.component('ElSelect', PeriodSelectStub);
  app.directive('loading', {});
  app.mount(root);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  return root;
}

function report(
  overrides: Partial<AnalyticsReport> = {},
): AnalyticsReport {
  return {
    reportKey: '2026-08-24#day',
    businessDate: '2026-08-24',
    shiftId: 'day',
    shiftNameSnapshot: '白班',
    responsiblePersonSnapshot: '田中',
    startMinuteOfDay: 8 * 60,
    endMinuteOfDay: 20 * 60,
    timeRangeLabelSnapshot: '08:00–20:00',
    previousImosBalanceYen: 10_000,
    currentImosBalanceYen: 14_000,
    newageYen: 3_000,
    cashTotalYen: 8_000,
    expenseYen: 200,
    expenseReason: '清掃用品',
    staffMealCashYen: 500,
    staffMealAlipayYen: 100,
    ...overrides,
  };
}

const zeroAggregate: ReportAggregate = {
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

describe('report analytics', () => {
  it('calculates every row with the shared domain contract before accumulating period totals', () => {
    const result = buildReportAnalytics(
      [
        report(),
        report({
          reportKey: '2026-08-24#night',
          shiftId: 'night',
          shiftNameSnapshot: '夜班',
          responsiblePersonSnapshot: '佐藤',
          startMinuteOfDay: 20 * 60,
          endMinuteOfDay: 8 * 60,
          timeRangeLabelSnapshot: '20:00–08:00',
          previousImosBalanceYen: 14_000,
          currentImosBalanceYen: 20_000,
          newageYen: 2_500,
          cashTotalYen: 10_000,
          expenseYen: 0,
          expenseReason: null,
          staffMealCashYen: 200,
          staffMealAlipayYen: 800,
        }),
      ],
      5_000,
    );

    expect(result.totals).toEqual({
      count: 2,
      imosSalesYen: 10_000,
      cashDepositYen: 8_000,
      totalSalesYen: 12_800,
      expenseYen: 200,
      deviationYen: 3_000,
      staffMealCashYen: 700,
      staffMealAlipayYen: 900,
      staffMealTotalYen: 1_600,
    });
    expect(result.rows.map((row) => ({
      reportKey: row.reportKey,
      totalSalesYen: row.totalSalesYen,
      staffMealTotalYen: row.staffMealTotalYen,
    }))).toEqual([
      {
        reportKey: '2026-08-24#day',
        totalSalesYen: 5_500,
        staffMealTotalYen: 600,
      },
      {
        reportKey: '2026-08-24#night',
        totalSalesYen: 7_300,
        staffMealTotalYen: 1_000,
      },
    ]);
  });

  it('aggregates repeated shifts independently from the period total', () => {
    const result = buildReportAnalytics(
      [
        report(),
        report({
          reportKey: '2026-08-25#day',
          businessDate: '2026-08-25',
          previousImosBalanceYen: 14_000,
          currentImosBalanceYen: 15_000,
          newageYen: 1_000,
          cashTotalYen: 6_000,
          expenseYen: 0,
          staffMealCashYen: 100,
          staffMealAlipayYen: 50,
        }),
      ],
      5_000,
    );

    expect(result.byShift).toEqual([
      {
        shiftId: 'day',
        shiftName: '白班',
        count: 2,
        imosSalesYen: 5_000,
        cashDepositYen: 4_000,
        totalSalesYen: 7_400,
        expenseYen: 200,
        deviationYen: 2_600,
        staffMealCashYen: 600,
        staffMealAlipayYen: 150,
        staffMealTotalYen: 750,
      },
    ]);
  });

  it('keeps overnight reports in their business day and derives their duration across midnight', () => {
    const result = buildReportAnalytics(
      [
        report({
          reportKey: '2026-08-24#night',
          shiftId: 'night',
          shiftNameSnapshot: '夜班',
          startMinuteOfDay: 22 * 60,
          endMinuteOfDay: 6 * 60,
          timeRangeLabelSnapshot: '22:00–06:00',
        }),
      ],
      5_000,
    );

    expect(result.rows[0]).toMatchObject({
      businessDate: '2026-08-24',
      timeRangeLabelSnapshot: '22:00–06:00',
      durationMinutes: 8 * 60,
    });
  });

  it('returns stable empty totals and no shift or detail rows', () => {
    expect(buildReportAnalytics([], 5_000)).toEqual({
      totals: zeroAggregate,
      byShift: [],
      rows: [],
    });
  });

  it('builds the actual-sales chart only from totalSalesYen so Alipay meal changes do not affect it', () => {
    const first = buildReportAnalytics([report()], 5_000);
    const changedAlipay = buildReportAnalytics(
      [report({ staffMealAlipayYen: 9_999 })],
      5_000,
    );

    expect(actualSalesBarData(first.byShift)).toEqual({
      categories: ['白班'],
      series: [{ name: '実際売上', data: [5_500] }],
    });
    expect(actualSalesBarData(changedAlipay.byShift)).toEqual(
      actualSalesBarData(first.byShift),
    );
  });
});

describe('Tokyo period boundaries', () => {
  it.each([
    ['day', '2026-08-24', { start: '2026-08-24', end: '2026-08-24' }],
    ['week', '2026-08-30', { start: '2026-08-24', end: '2026-08-30' }],
    ['month', '2026-02-12', { start: '2026-02-01', end: '2026-02-28' }],
    ['quarter', '2026-05-20', { start: '2026-04-01', end: '2026-06-30' }],
    ['year', '2024-06-15', { start: '2024-01-01', end: '2024-12-31' }],
  ] as const)('uses Tokyo calendar boundaries for %s', (period, anchor, expected) => {
    expect(tokyoPeriodRange(period, anchor)).toEqual(expected);
  });

  it('rejects an invalid anchor instead of silently changing calendar dates', () => {
    expect(() => tokyoPeriodRange('month', '2026-02-30')).toThrow(
      'ANALYTICS_ANCHOR_DATE_INVALID',
    );
  });
});

describe('OWNER analytics page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repositoryMocks.getSetting.mockResolvedValue({
      registerFloatAmount: 5_000,
    });
  });

  it('reads the selected Tokyo period through daily indexes and renders domain-derived totals', async () => {
    expect(viewLoader.loadOwnerAnalytics).toBeTypeOf('function');

    const fixedList = vi.fn(async (date: string) =>
      date === '2026-08-24' ? [report()] : [],
    );
    const loaded = await viewLoader.loadOwnerAnalytics({
      period: 'week',
      anchorDate: '2026-08-24',
      listByBusinessDate: fixedList,
      getSetting: vi.fn().mockResolvedValue({ registerFloatAmount: 5_000 }),
    });

    expect(fixedList.mock.calls).toEqual([
      ['2026-08-24'],
      ['2026-08-25'],
      ['2026-08-26'],
      ['2026-08-27'],
      ['2026-08-28'],
      ['2026-08-29'],
      ['2026-08-30'],
    ]);
    expect(loaded.range).toEqual({
      start: '2026-08-24',
      end: '2026-08-30',
    });
    expect(loaded.analytics.totals.totalSalesYen).toBe(5_500);

    const currentBusinessDate = todayTokyo();
    repositoryMocks.listByBusinessDate.mockImplementation(
      async (date: string) =>
        date === currentBusinessDate
          ? [
              report({
                reportKey: `${date}#day`,
                businessDate: date,
              }),
            ]
          : [],
    );

    const root = await renderAnalyticsView();
    const visible = root.textContent ?? '';

    expect(repositoryMocks.listByBusinessDate).toHaveBeenCalledTimes(7);
    expect(visible).toContain('対象 1 件');
    expect(visible).toContain('実際売上');
    expect(visible).toContain('5,500 円');
    expect(visible).toContain('网管餐費（現金）');
    expect(visible).toContain('500 円');
    expect(visible).toContain('网管餐費（支付宝）');
    expect(visible).toContain('100 円');
    expect(visible).toContain('网管餐費合計');
    expect(visible).toContain('600 円');
  });

  it('disables CSV export while a changed period is still loading', async () => {
    repositoryMocks.listByBusinessDate.mockResolvedValue([]);
    const root = await renderAnalyticsView();
    let resolvePending!: (rows: AnalyticsReport[]) => void;
    const pending = new Promise<AnalyticsReport[]>((resolve) => {
      resolvePending = resolve;
    });
    repositoryMocks.listByBusinessDate.mockImplementation(() => pending);

    root.querySelector<HTMLButtonElement>('[data-testid="period-change"]')?.click();
    await nextTick();

    const csvButton = [...root.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('CSV を出力'),
    );
    expect(csvButton?.disabled).toBe(true);

    resolvePending([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
