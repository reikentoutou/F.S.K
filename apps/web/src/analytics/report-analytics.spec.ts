// @vitest-environment jsdom

import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  actualSalesBarData,
  buildReportAnalytics,
  tokyoPeriodRange,
  type AnalyticsReport,
  type ReportAggregate,
} from './report-analytics';
import { DataRepositoryError } from '@/data/errors';
import { todayTokyo } from '@/utils/tokyo';
import * as analyticsView from '@/views/admin/AnalyticsView.vue';

const repositoryMocks = vi.hoisted(() => ({
  listByBusinessDate: vi.fn(),
  getSetting: vi.fn(),
  listShifts: vi.fn(),
}));

const downloadMocks = vi.hoisted(() => ({
  buildReportCsv: vi.fn(() => '\ufeffcsv'),
  downloadCsvFile: vi.fn(),
}));

const chartMocks = vi.hoisted(() => ({
  setBarData: vi.fn(),
}));

const messageMocks = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock('@/data/daily-reports', () => ({
  dailyReportsRepository: {
    listByBusinessDate: repositoryMocks.listByBusinessDate,
  },
}));

vi.mock('@/data/master-data', () => ({
  ownerMasterDataRepository: {
    getSetting: repositoryMocks.getSetting,
    listShifts: repositoryMocks.listShifts,
  },
}));

vi.mock('@/composables/useEchartsBarChart', () => ({
  useEchartsBarChart: () => ({
    setBarData: chartMocks.setBarData,
    resize: vi.fn(),
  }),
}));

vi.mock('@/export/report-csv', () => downloadMocks);

vi.mock('element-plus', () => ({ ElMessage: messageMocks }));

interface AnalyticsLoader {
  loadOwnerAnalytics(options: {
    period: 'day' | 'week' | 'month' | 'quarter' | 'year';
    anchorDate: string;
    listByBusinessDate(date: string): Promise<Array<AnalyticsReport | null>>;
    getSetting(id: string): Promise<{ registerFloatAmount: number }>;
    listShifts(): Promise<
      Array<{ id: string; sortOrder: number } | null>
    >;
    isCurrent?: () => boolean;
  }): Promise<{
    range: { start: string; end: string };
    registerFloatAmount: number;
    analytics: ReturnType<typeof buildReportAnalytics>;
  }>;
  ownerAnalyticsErrorMessage(error: unknown): string;
  analyticsCsvFilename(selection: {
    period: 'day' | 'week' | 'month' | 'quarter' | 'year';
    range: { start: string; end: string };
  }): string;
}

const viewLoader = analyticsView as unknown as AnalyticsLoader;

const Passthrough = defineComponent({
  props: { label: String, title: String },
  setup(props, { slots, attrs }) {
    return () =>
      h('div', attrs, [
        props.title ? h('h3', props.title) : null,
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

let nextPeriod: 'day' | 'week' | 'month' | 'quarter' | 'year' = 'day';

const PeriodSelectStub = defineComponent({
  emits: ['update:modelValue'],
  setup(_props, { emit }) {
    return () =>
      h(
        'button',
        {
          'data-testid': 'period-change',
          onClick: () => emit('update:modelValue', nextPeriod),
        },
        '期間変更',
      );
  },
});

async function mountAnalyticsView(): Promise<{
  app: App;
  root: HTMLElement;
}> {
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
  return { app, root };
}

async function renderAnalyticsView(): Promise<HTMLElement> {
  return (await mountAnalyticsView()).root;
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

const defaultShiftSortOrders = new Map([
  ['day', 1],
  ['night', 2],
]);

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
      defaultShiftSortOrders,
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
      defaultShiftSortOrders,
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

  it('orders known shifts by master sort order and unknown history by time/id while preserving overnight labels', () => {
    const result = buildReportAnalytics(
      [
        report(),
        report({
          reportKey: '2026-08-24#night',
          shiftId: 'night',
          shiftNameSnapshot: '夜班',
          startMinuteOfDay: 22 * 60,
          endMinuteOfDay: 6 * 60,
          timeRangeLabelSnapshot: '22:00–06:00',
        }),
        report({
          reportKey: '2026-08-24#unknown-b',
          shiftId: 'unknown-b',
          shiftNameSnapshot: '历史乙班',
          startMinuteOfDay: 21 * 60,
        }),
        report({
          reportKey: '2026-08-24#unknown-a',
          shiftId: 'unknown-a',
          shiftNameSnapshot: '历史甲班',
          startMinuteOfDay: 21 * 60,
        }),
      ],
      5_000,
      new Map([
        ['night', 1],
        ['day', 2],
      ]),
    );

    expect(
      result.rows.map((row) => [row.shiftId, row.timeRangeLabelSnapshot]),
    ).toEqual([
      ['night', '22:00–06:00'],
      ['day', '08:00–20:00'],
      ['unknown-a', '08:00–20:00'],
      ['unknown-b', '08:00–20:00'],
    ]);
    expect(result.byShift.map((shift) => shift.shiftId)).toEqual([
      'night',
      'day',
      'unknown-a',
      'unknown-b',
    ]);
    expect(actualSalesBarData(result.byShift).categories).toEqual([
      '夜班',
      '白班',
      '历史甲班',
      '历史乙班',
    ]);
  });

  it('returns stable empty totals and no shift or detail rows', () => {
    expect(
      buildReportAnalytics([], 5_000, defaultShiftSortOrders),
    ).toEqual({
      totals: zeroAggregate,
      byShift: [],
      rows: [],
    });
  });

  it('builds the actual-sales chart only from totalSalesYen so Alipay meal changes do not affect it', () => {
    const first = buildReportAnalytics(
      [report()],
      5_000,
      defaultShiftSortOrders,
    );
    const changedAlipay = buildReportAnalytics(
      [report({ staffMealAlipayYen: 9_999 })],
      5_000,
      defaultShiftSortOrders,
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
    nextPeriod = 'day';
    repositoryMocks.getSetting.mockResolvedValue({
      registerFloatAmount: 5_000,
    });
    repositoryMocks.listShifts.mockResolvedValue([
      { id: 'day', sortOrder: 1, active: true },
    ]);
    downloadMocks.buildReportCsv.mockClear();
    downloadMocks.downloadCsvFile.mockClear();
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
      listShifts: vi.fn().mockResolvedValue([
        { id: 'day', sortOrder: 1, active: true },
      ]),
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

  it('fails closed when AppSetting/default is missing without reading or returning reports', async () => {
    const missing = new DataRepositoryError('DATA_NOT_FOUND');
    const listByBusinessDate = vi.fn().mockResolvedValue([report()]);

    await expect(
      viewLoader.loadOwnerAnalytics({
        period: 'week',
        anchorDate: '2026-08-24',
        listByBusinessDate,
        getSetting: vi.fn().mockRejectedValue(missing),
        listShifts: vi.fn().mockResolvedValue([]),
      }),
    ).rejects.toBe(missing);
    expect(listByBusinessDate).not.toHaveBeenCalled();
  });

  it('loads active and inactive shift masters and applies their explicit sort order', async () => {
    const listShifts = vi.fn().mockResolvedValue([
      { id: 'day', sortOrder: 20, active: true },
      { id: 'night', sortOrder: 10, active: false },
    ]);
    const loaded = await viewLoader.loadOwnerAnalytics({
      period: 'day',
      anchorDate: '2026-08-24',
      getSetting: vi.fn().mockResolvedValue({ registerFloatAmount: 5_000 }),
      listShifts,
      listByBusinessDate: vi.fn().mockResolvedValue([
        report(),
        report({
          reportKey: '2026-08-24#night',
          shiftId: 'night',
          shiftNameSnapshot: '夜班',
          startMinuteOfDay: 22 * 60,
          endMinuteOfDay: 6 * 60,
          timeRangeLabelSnapshot: '22:00–06:00',
        }),
      ]),
    });

    expect(listShifts).toHaveBeenCalledOnce();
    expect(loaded.analytics.rows.map((row) => row.shiftId)).toEqual([
      'night',
      'day',
    ]);
  });

  it('renders single-day shift details in master order with the overnight label intact', async () => {
    repositoryMocks.listShifts.mockResolvedValue([
      { id: 'day', sortOrder: 20, active: true },
      { id: 'night', sortOrder: 10, active: false },
    ]);
    const currentBusinessDate = todayTokyo();
    repositoryMocks.listByBusinessDate.mockImplementation(
      async (date: string) =>
        date === currentBusinessDate
          ? [
              report({ reportKey: `${date}#day`, businessDate: date }),
              report({
                reportKey: `${date}#night`,
                businessDate: date,
                shiftId: 'night',
                shiftNameSnapshot: '夜班',
                startMinuteOfDay: 22 * 60,
                endMinuteOfDay: 6 * 60,
                timeRangeLabelSnapshot: '22:00–06:00',
              }),
            ]
          : [],
    );
    const root = await renderAnalyticsView();

    root.querySelector<HTMLButtonElement>('[data-testid="period-change"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    const visible = root.textContent ?? '';

    expect(visible.indexOf('夜班')).toBeLessThan(visible.indexOf('白班'));
    expect(visible).toContain('22:00–06:00');
  });

  it('stops a stale generation before starting the next ten-day batch', async () => {
    let current = true;
    let releaseFirstBatch!: (rows: AnalyticsReport[]) => void;
    const firstBatch = new Promise<AnalyticsReport[]>((resolve) => {
      releaseFirstBatch = resolve;
    });
    const listByBusinessDate = vi.fn(() => firstBatch);

    const pending = viewLoader.loadOwnerAnalytics({
      period: 'month',
      anchorDate: '2026-08-15',
      getSetting: vi.fn().mockResolvedValue({ registerFloatAmount: 5_000 }),
      listShifts: vi.fn().mockResolvedValue([]),
      listByBusinessDate,
      isCurrent: () => current,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listByBusinessDate).toHaveBeenCalledTimes(10);

    current = false;
    releaseFirstBatch([]);

    await expect(pending).rejects.toMatchObject({
      message: 'ANALYTICS_LOAD_ABORTED',
    });
    expect(listByBusinessDate).toHaveBeenCalledTimes(10);
  });

  it('propagates a current repository failure without converting it into an abort', async () => {
    const failure = new DataRepositoryError('DATA_NETWORK_ERROR');

    await expect(
      viewLoader.loadOwnerAnalytics({
        period: 'day',
        anchorDate: '2026-08-24',
        getSetting: vi.fn().mockResolvedValue({ registerFloatAmount: 5_000 }),
        listShifts: vi.fn().mockResolvedValue([]),
        listByBusinessDate: vi.fn().mockRejectedValue(failure),
        isCurrent: () => true,
      }),
    ).rejects.toBe(failure);
  });

  it('does not start report reads when the generation expires during shift metadata loading', async () => {
    let current = true;
    let releaseShifts!: (
      shifts: Array<{ id: string; sortOrder: number }>,
    ) => void;
    const shifts = new Promise<Array<{ id: string; sortOrder: number }>>(
      (resolve) => {
        releaseShifts = resolve;
      },
    );
    const listByBusinessDate = vi.fn();
    const pending = viewLoader.loadOwnerAnalytics({
      period: 'day',
      anchorDate: '2026-08-24',
      getSetting: vi.fn().mockResolvedValue({ registerFloatAmount: 5_000 }),
      listShifts: () => shifts,
      listByBusinessDate,
      isCurrent: () => current,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    current = false;
    releaseShifts([]);

    await expect(pending).rejects.toMatchObject({
      message: 'ANALYTICS_LOAD_ABORTED',
    });
    expect(listByBusinessDate).not.toHaveBeenCalled();
  });

  it('stops the production year load after unmount without starting another batch or writing UI', async () => {
    repositoryMocks.listByBusinessDate.mockResolvedValue([]);
    const { app, root } = await mountAnalyticsView();
    repositoryMocks.listByBusinessDate.mockClear();
    chartMocks.setBarData.mockClear();
    messageMocks.error.mockClear();
    nextPeriod = 'year';
    let releaseFirstBatch!: (rows: AnalyticsReport[]) => void;
    const firstBatch = new Promise<AnalyticsReport[]>((resolve) => {
      releaseFirstBatch = resolve;
    });
    repositoryMocks.listByBusinessDate.mockImplementation(() => firstBatch);

    root.querySelector<HTMLButtonElement>('[data-testid="period-change"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(repositoryMocks.listByBusinessDate).toHaveBeenCalledTimes(10);

    app.unmount();
    releaseFirstBatch([]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(repositoryMocks.listByBusinessDate).toHaveBeenCalledTimes(10);
    expect(chartMocks.setBarData).not.toHaveBeenCalled();
    expect(messageMocks.error).not.toHaveBeenCalled();
    expect(root.textContent).toBe('');
  });

  it('does not show a repository error that arrives after the production view unmounts', async () => {
    repositoryMocks.listByBusinessDate.mockResolvedValue([]);
    const { app, root } = await mountAnalyticsView();
    messageMocks.error.mockClear();
    let rejectRead!: (error: unknown) => void;
    const pendingRead = new Promise<AnalyticsReport[]>((_resolve, reject) => {
      rejectRead = reject;
    });
    repositoryMocks.listByBusinessDate.mockImplementation(() => pendingRead);

    root.querySelector<HTMLButtonElement>('[data-testid="period-change"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    app.unmount();
    rejectRead(new DataRepositoryError('DATA_NETWORK_ERROR'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(messageMocks.error).not.toHaveBeenCalled();
  });

  it.each([
    [
      new DataRepositoryError('DATA_NOT_FOUND'),
      'レジ底銭設定が見つかりません。設定画面で登録してください',
    ],
    [
      new DataRepositoryError('DATA_UNAUTHORIZED'),
      '权限不足，请重新以老板账号登录',
    ],
    [
      new DataRepositoryError('DATA_PAGINATION_FAILED'),
      '分页读取失败，请重试',
    ],
    [
      new DataRepositoryError('DATA_NETWORK_ERROR'),
      '网络异常，请确认连接后重试',
    ],
  ])('maps metadata/read failures to a stable OWNER message', (error, message) => {
    expect(viewLoader.ownerAnalyticsErrorMessage(error)).toBe(message);
  });

  it('downloads with the last loaded period/range snapshot even before a new watcher starts', async () => {
    repositoryMocks.listByBusinessDate.mockResolvedValue([]);
    const root = await renderAnalyticsView();
    const expectedRange = tokyoPeriodRange('week', todayTokyo());
    let releasePending!: (rows: AnalyticsReport[]) => void;
    const pending = new Promise<AnalyticsReport[]>((resolve) => {
      releasePending = resolve;
    });
    repositoryMocks.listByBusinessDate.mockImplementation(() => pending);

    root.querySelector<HTMLButtonElement>('[data-testid="period-change"]')?.click();
    const csvButton = [...root.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('CSV を出力'),
    );
    csvButton?.click();

    expect(downloadMocks.downloadCsvFile).toHaveBeenCalledWith(
      '\ufeffcsv',
      `aggregate-week-${expectedRange.start}-${expectedRange.end}.csv`,
    );

    releasePending([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
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
