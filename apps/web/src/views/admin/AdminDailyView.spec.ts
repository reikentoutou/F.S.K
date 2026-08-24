// @vitest-environment jsdom

import {
  computed,
  createApp,
  defineComponent,
  h,
  inject,
  nextTick,
  provide,
  type ComputedRef,
  type PropType,
} from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DataRepositoryError } from '@/data/errors';
import { todayTokyo } from '@/utils/tokyo';
import * as dailyView from './AdminDailyView.vue';

const repositoryMocks = vi.hoisted(() => ({
  listByBusinessDate: vi.fn(),
  getSetting: vi.fn(),
  listShifts: vi.fn(),
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

interface DailyLoader {
  loadOwnerDailyReports<T>(options: {
    now?: Date;
    dates?: string[];
    listByBusinessDate(date: string): Promise<Array<T | null>>;
    getSetting(id: string): Promise<{ registerFloatAmount: number }>;
  }): Promise<{ rows: T[]; registerFloatAmount: number }>;
}

const loader = dailyView as unknown as DailyLoader;

const tableRowsKey = Symbol('tableRows');

const Passthrough = defineComponent({
  setup(_props, { slots, attrs }) {
    return () =>
      h('div', attrs, [
        slots.title?.(),
        slots.description?.(),
        slots.default?.(),
        slots.footer?.(),
      ]);
  },
});

const TableStub = defineComponent({
  props: {
    data: {
      type: Array as PropType<Array<Record<string, unknown>>>,
      default: () => [],
    },
  },
  setup(props, { slots, attrs }) {
    provide(tableRowsKey, computed(() => props.data));
    return () => h('div', attrs, slots.default?.());
  },
});

const TableColumnStub = defineComponent({
  props: { label: String },
  setup(props, { slots }) {
    const rows = inject<ComputedRef<Array<Record<string, unknown>>>>(
      tableRowsKey,
      computed(() => []),
    );
    return () =>
      h('div', [
        h('strong', props.label ?? ''),
        ...rows.value.flatMap((row) => slots.default?.({ row }) ?? []),
      ]);
  },
});

async function renderDailyView(): Promise<HTMLElement> {
  const root = document.createElement('div');
  const app = createApp(dailyView.default);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: Passthrough }],
  });
  await router.push('/');
  await router.isReady();
  app.use(router);
  for (const name of [
    'ElButton',
    'ElDatePicker',
    'ElEmpty',
    'ElCollapse',
    'ElCollapseItem',
    'ElTag',
    'ElDialog',
    'ElForm',
    'ElFormItem',
    'ElSelect',
    'ElOption',
  ]) {
    app.component(name, Passthrough);
  }
  app.component('ElTable', TableStub);
  app.component('ElTableColumn', TableColumnStub);
  app.directive('loading', {});
  app.mount(root);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  repositoryMocks.getSetting.mockResolvedValue({ registerFloatAmount: 5_000 });
  repositoryMocks.listShifts.mockResolvedValue([]);
});

describe('OWNER daily repository orchestration', () => {
  it('reads the latest 90 Tokyo dates through the business-date index', async () => {
    const listByBusinessDate = vi.fn(async (date: string) => [
      { reportKey: `${date}#day` },
    ]);

    const result = await loader.loadOwnerDailyReports({
      now: new Date('2026-08-24T03:00:00.000Z'),
      listByBusinessDate,
      getSetting: vi.fn().mockResolvedValue({ registerFloatAmount: 5_000 }),
    });

    expect(listByBusinessDate).toHaveBeenCalledTimes(90);
    expect(listByBusinessDate.mock.calls[0]).toEqual(['2026-05-27']);
    expect(listByBusinessDate.mock.calls.at(-1)).toEqual(['2026-08-24']);
    expect(result.rows).toHaveLength(90);
    expect(result.registerFloatAmount).toBe(5_000);
  });

  it('rejects the whole read with the stable classification when any indexed day fails', async () => {
    const failure = new DataRepositoryError('DATA_NETWORK_ERROR');
    const listByBusinessDate = vi
      .fn()
      .mockResolvedValueOnce([{ reportKey: '2026-08-23#day' }])
      .mockRejectedValueOnce(failure);

    await expect(
      loader.loadOwnerDailyReports({
        dates: ['2026-08-23', '2026-08-24'],
        listByBusinessDate,
        getSetting: vi.fn().mockResolvedValue({ registerFloatAmount: 0 }),
      }),
    ).rejects.toBe(failure);
    expect(listByBusinessDate).toHaveBeenCalledTimes(2);
  });

  it('renders same-day reports with both meal details, shared totals and a horizontal detail region', async () => {
    const businessDate = todayTokyo();
    repositoryMocks.listByBusinessDate.mockImplementation(
      async (date: string) =>
        date === businessDate
          ? [
              {
                reportKey: `${date}#day`,
                businessDate: date,
                shiftId: 'day',
                shiftNameSnapshot: '日班',
                previousImosBalanceYen: 10_000,
                currentImosBalanceYen: 14_000,
                newageYen: 2_000,
                cashTotalYen: 15_000,
                expenseYen: 0,
                staffMealCashYen: 100,
                staffMealAlipayYen: 50,
              },
              {
                reportKey: `${date}#night`,
                businessDate: date,
                shiftId: 'night',
                shiftNameSnapshot: '夜班',
                previousImosBalanceYen: 14_000,
                currentImosBalanceYen: 18_000,
                newageYen: 3_000,
                cashTotalYen: 12_000,
                expenseYen: 0,
                staffMealCashYen: 200,
                staffMealAlipayYen: 75,
              },
            ]
          : [],
    );

    const root = await renderDailyView();
    const visible = root.textContent ?? '';

    expect(visible).toContain('1 業務日 · 2 件');
    expect(visible).toContain('実際売上計 21,700 円');
    expect(visible).toContain('网管餐費計 425 円');
    expect(visible).toContain('网管餐費（現金）');
    expect(visible).toContain('100 円');
    expect(visible).toContain('200 円');
    expect(visible).toContain('网管餐費（支付宝）');
    expect(visible).toContain('50 円');
    expect(visible).toContain('75 円');
    expect(visible).toContain('网管餐費合計');
    expect(visible).toContain('150 円');
    expect(visible).toContain('275 円');
    expect(
      root.querySelector(
        '[role="region"][aria-label="横スクロール可能な日報明細"]',
      ),
    ).not.toBeNull();
  });
});
