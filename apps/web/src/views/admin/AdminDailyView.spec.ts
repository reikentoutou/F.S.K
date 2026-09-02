// @vitest-environment jsdom

import {
  type App,
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DataRepositoryError } from '@/data/errors';
import { todayTokyo } from '@/utils/tokyo';
import * as dailyView from './AdminDailyView.vue';

const repositoryMocks = vi.hoisted(() => ({
  listByBusinessDate: vi.fn(),
  getSetting: vi.fn(),
  listShifts: vi.fn(),
}));

const elementPlusMocks = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock('element-plus', () => ({
  ElMessage: { error: elementPlusMocks.error },
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
    isCurrent?: () => boolean;
    listByBusinessDate(date: string): Promise<Array<T | null>>;
    getSetting(id: string): Promise<{ registerFloatAmount: number }>;
  }): Promise<{ rows: T[]; registerFloatAmount: number }>;
}

const loader = dailyView as unknown as DailyLoader;

const tableRowsKey = Symbol('tableRows');
const mountedApps = new Set<App>();

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await settleAsyncWork();
  }
  throw new Error('TEST_WAIT_TIMEOUT');
}

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

const ButtonStub = defineComponent({
  props: { loading: Boolean },
  setup(props, { slots, attrs }) {
    return () =>
      h(
        'button',
        { ...attrs, 'aria-busy': String(props.loading) },
        slots.default?.(),
      );
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

async function mountDailyView(): Promise<{ app: App; root: HTMLElement }> {
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
    'ElIcon',
  ]) {
    app.component(name, Passthrough);
  }
  app.component('ElButton', ButtonStub);
  app.component('ElTable', TableStub);
  app.component('ElTableColumn', TableColumnStub);
  app.directive('loading', {});
  app.mount(root);
  mountedApps.add(app);
  await settleAsyncWork();
  return { app, root };
}

async function renderDailyView(): Promise<HTMLElement> {
  return (await mountDailyView()).root;
}

function loadButton(root: HTMLElement): HTMLElement {
  const button = [...root.querySelectorAll<HTMLElement>('button')].find(
    (element) => element.textContent === '読み込む',
  );
  if (!button) throw new Error('LOAD_BUTTON_NOT_FOUND');
  return button;
}

beforeEach(() => {
  vi.clearAllMocks();
  repositoryMocks.getSetting.mockResolvedValue({ registerFloatAmount: 5_000 });
  repositoryMocks.listShifts.mockResolvedValue([]);
});

afterEach(() => {
  for (const app of mountedApps) app.unmount();
  mountedApps.clear();
});

describe('OWNER daily repository orchestration', () => {
  it('fails closed without AppSetting/default before querying or rendering report totals', async () => {
    const missingSetting = new DataRepositoryError('DATA_NOT_FOUND');
    repositoryMocks.getSetting.mockRejectedValue(missingSetting);
    repositoryMocks.listByBusinessDate.mockResolvedValue([
      {
        reportKey: `${todayTokyo()}#day`,
        businessDate: todayTokyo(),
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
    ]);

    const root = await renderDailyView();

    expect(repositoryMocks.listByBusinessDate).not.toHaveBeenCalled();
    expect(root.textContent).toContain('実際売上合計0 円');
    expect(root.textContent).not.toContain('21,900 円');
  });

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

  it('limits indexed day reads to at most ten concurrent requests', async () => {
    let active = 0;
    let maxActive = 0;
    const listByBusinessDate = vi.fn(async (date: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return [{ reportKey: `${date}#day` }];
    });

    const result = await loader.loadOwnerDailyReports({
      now: new Date('2026-08-24T03:00:00.000Z'),
      listByBusinessDate,
      getSetting: vi.fn().mockResolvedValue({ registerFloatAmount: 5_000 }),
    });

    expect(maxActive).toBe(10);
    expect(listByBusinessDate).toHaveBeenCalledTimes(90);
    expect(result.rows).toHaveLength(90);
  });

  it('keeps the current load active and ignores an older late failure', async () => {
    const oldLoad = deferred<Array<Record<string, unknown> | null>>();
    const currentLoad = deferred<Array<Record<string, unknown> | null>>();
    let useCurrentLoad = false;
    repositoryMocks.listByBusinessDate.mockImplementation(() =>
      useCurrentLoad ? currentLoad.promise : oldLoad.promise,
    );
    const { root } = await mountDailyView();
    await waitFor(() => repositoryMocks.listByBusinessDate.mock.calls.length >= 10);

    const callsBeforeCurrentLoad = repositoryMocks.listByBusinessDate.mock.calls.length;
    useCurrentLoad = true;
    loadButton(root).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(
      () =>
        repositoryMocks.listByBusinessDate.mock.calls.length >
        callsBeforeCurrentLoad,
    );
    oldLoad.reject(new DataRepositoryError('DATA_NETWORK_ERROR'));
    await settleAsyncWork();

    expect(elementPlusMocks.error).not.toHaveBeenCalled();
    expect(loadButton(root).getAttribute('aria-busy')).toBe('true');

    currentLoad.resolve([
      {
        reportKey: `${todayTokyo()}#current`,
        businessDate: todayTokyo(),
        shiftId: 'current',
        shiftNameSnapshot: '現在班',
        previousImosBalanceYen: 10_000,
        currentImosBalanceYen: 14_000,
        newageYen: 2_000,
        cashTotalYen: 15_000,
        expenseYen: 0,
        staffMealCashYen: 100,
        staffMealAlipayYen: 50,
      },
    ]);
    await waitFor(() => root.textContent?.includes('1 営業日 · 90 件') === true);

    expect(root.textContent).toContain('1 営業日 · 90 件');
    expect(loadButton(root).getAttribute('aria-busy')).toBe('false');
    expect(elementPlusMocks.error).not.toHaveBeenCalled();
  });

  it('stops an older successful load before it starts another date batch', async () => {
    const oldLoad = deferred<Array<Record<string, unknown> | null>>();
    const currentLoad = deferred<Array<Record<string, unknown> | null>>();
    let useCurrentLoad = false;
    repositoryMocks.listByBusinessDate.mockImplementation(() =>
      useCurrentLoad ? currentLoad.promise : oldLoad.promise,
    );
    const { root } = await mountDailyView();
    await waitFor(() => repositoryMocks.listByBusinessDate.mock.calls.length === 10);

    useCurrentLoad = true;
    loadButton(root).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => repositoryMocks.listByBusinessDate.mock.calls.length === 20);
    oldLoad.resolve([]);
    await settleAsyncWork();

    expect(repositoryMocks.listByBusinessDate).toHaveBeenCalledTimes(20);
    currentLoad.resolve([]);
  });

  it('invalidates an in-flight load before unmount so its late failure is silent', async () => {
    const pendingLoad = deferred<Array<Record<string, unknown> | null>>();
    repositoryMocks.listByBusinessDate.mockImplementation(
      () => pendingLoad.promise,
    );
    const { app } = await mountDailyView();
    await waitFor(() => repositoryMocks.listByBusinessDate.mock.calls.length >= 10);

    app.unmount();
    mountedApps.delete(app);
    pendingLoad.reject(new DataRepositoryError('DATA_NETWORK_ERROR'));
    await settleAsyncWork();

    expect(elementPlusMocks.error).not.toHaveBeenCalled();
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

    expect(visible).toContain('1 営業日 · 2 件');
    expect(visible).toContain('実際売上合計 21,700 円');
    expect(visible).toContain('スタッフ食事代合計 425 円');
    expect(visible).toContain('スタッフ食事代（現金）');
    expect(visible).toContain('100 円');
    expect(visible).toContain('200 円');
    expect(visible).toContain('スタッフ食事代（アリペイ）');
    expect(visible).toContain('50 円');
    expect(visible).toContain('75 円');
    expect(visible).toContain('スタッフ食事代合計');
    expect(visible).toContain('150 円');
    expect(visible).toContain('275 円');
    expect(
      root.querySelector(
        '[role="region"][aria-label="横スクロール可能な日報明細"]',
      ),
    ).not.toBeNull();
  });
});
