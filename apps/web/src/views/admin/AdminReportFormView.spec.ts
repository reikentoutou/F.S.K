// @vitest-environment jsdom

import { createApp, defineComponent, h, nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateDailyReportCommand } from '@/data/daily-reports';
import { DataRepositoryError } from '@/data/errors';
import * as reportView from './AdminReportFormView.vue';

const repositoryMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  listShifts: vi.fn(),
  listResponsiblePersons: vi.fn(),
  getByReportKey: vi.fn(),
  create: vi.fn(),
  updateByReportKey: vi.fn(),
}));

vi.mock('@/data/master-data', () => ({
  ownerMasterDataRepository: {
    getSetting: repositoryMocks.getSetting,
    listShifts: repositoryMocks.listShifts,
    listResponsiblePersons: repositoryMocks.listResponsiblePersons,
  },
}));

vi.mock('@/data/daily-reports', () => ({
  dailyReportsRepository: {
    getByReportKey: repositoryMocks.getByReportKey,
    create: repositoryMocks.create,
    updateByReportKey: repositoryMocks.updateByReportKey,
  },
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: { username: 'owner-test' },
  }),
}));

const Passthrough = defineComponent({
  setup(_props, { slots, attrs }) {
    return () =>
      h('div', attrs, [
        slots.default?.(),
        slots.title?.(),
        slots.description?.(),
        slots.footer?.(),
      ]);
  },
});

async function renderReportForm(): Promise<HTMLElement> {
  const root = document.createElement('div');
  const app = createApp(reportView.default);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/owner/daily/new',
        name: 'owner-report-new',
        component: reportView.default,
      },
      { path: '/owner/daily', name: 'owner-daily', component: Passthrough },
    ],
  });
  await router.push({
    name: 'owner-report-new',
    query: { businessDate: '2026-08-24', shiftId: 'day' },
  });
  await router.isReady();
  app.use(router);
  app.component('ElButton', Passthrough);
  app.component('ElForm', Passthrough);
  app.directive('loading', {});
  app.mount(root);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  return root;
}

interface ReportActions {
  saveOwnerReport(
    reportKey: string | null,
    command: CreateDailyReportCommand,
    repository: {
      create(command: CreateDailyReportCommand): Promise<unknown>;
      updateByReportKey(reportKey: string, changes: unknown): Promise<unknown>;
    },
  ): Promise<unknown>;
  loadOwnerReport(
    reportKey: string,
    repository: { getByReportKey(reportKey: string): Promise<unknown> },
  ): Promise<unknown>;
  ownerReportDataErrorMessage(error: unknown, fallback: string): string;
  createOwnerReportLoadController<T>(callbacks: {
    reset(): void;
    setLoading(value: boolean): void;
    apply(value: T): void;
    fail(error: unknown): void;
  }): {
    load(read: () => Promise<T>): Promise<void>;
    invalidate(): void;
  };
  createOwnerReportSaveController(callbacks: {
    setSaving(value: boolean): void;
    succeed(): void;
    fail(error: unknown): void;
  }): {
    run(
      save: (isCurrent: () => boolean) => Promise<unknown>,
    ): Promise<boolean>;
    invalidate(): void;
  };
  responsiblePersonSnapshot(
    existing: {
      responsiblePersonId: string;
      responsiblePersonSnapshot: string;
    } | null,
    selectedId: string,
    selectedMasterName: string,
  ): string;
  ownerReportPersonName(
    existing: {
      responsiblePersonId: string;
      responsiblePersonSnapshot: string;
    } | null,
    selectedId: string,
    persons: Array<{ id: string; name: string }>,
  ): string;
}

const actions = reportView as unknown as ReportActions;
const command: CreateDailyReportCommand = {
  businessDate: '2026-08-24',
  shiftId: 'day',
  shiftNameSnapshot: '日班',
  responsiblePersonId: 'p1',
  responsiblePersonSnapshot: '张三',
  startMinuteOfDay: 540,
  endMinuteOfDay: 1020,
  timeRangeLabelSnapshot: '09:00–17:00',
  previousImosBalanceYen: 10_000,
  currentImosBalanceYen: 20_000,
  newageYen: 3_000,
  cashTotalYen: 12_000,
  expenseYen: 500,
  expenseReason: '消耗品',
  staffMealCashYen: 800,
  staffMealAlipayYen: 600,
  attachmentKeys: ['receipts/a.jpg'],
};

beforeEach(() => {
  vi.clearAllMocks();
  repositoryMocks.getSetting.mockResolvedValue({ registerFloatAmount: 5_000 });
  repositoryMocks.listShifts.mockResolvedValue([]);
  repositoryMocks.listResponsiblePersons.mockResolvedValue([]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('OWNER report repository actions', () => {
  it('keeps the form and submission unavailable when AppSetting/default is missing', async () => {
    repositoryMocks.getSetting.mockRejectedValue(
      new DataRepositoryError('DATA_NOT_FOUND'),
    );

    const root = await renderReportForm();
    const visible = root.textContent ?? '';

    expect(visible).toContain('見つかりません');
    expect(visible).not.toContain('底銭');
    expect(visible).not.toContain('入力内容を確認');
    expect(visible).not.toContain('日報を追加');
    expect(repositoryMocks.create).not.toHaveBeenCalled();
    expect(repositoryMocks.updateByReportKey).not.toHaveBeenCalled();
  });

  it('creates a backfill through create without a client-supplied owner', async () => {
    const create = vi.fn().mockResolvedValue({ reportKey: '2026-08-24#day' });
    const updateByReportKey = vi.fn();

    await actions.saveOwnerReport(null, command, { create, updateByReportKey });

    expect(create).toHaveBeenCalledWith(command);
    expect(updateByReportKey).not.toHaveBeenCalled();
    expect(command).not.toHaveProperty('owner');
  });

  it('gets an edit by reportKey and updates only mutable fields', async () => {
    const getByReportKey = vi.fn().mockResolvedValue({
      reportKey: '2026-08-24#day',
      submittedAt: '2026-08-24T10:00:00.000Z',
    });
    await expect(
      actions.loadOwnerReport('2026-08-24#day', { getByReportKey }),
    ).resolves.toMatchObject({ reportKey: '2026-08-24#day' });
    expect(getByReportKey).toHaveBeenCalledWith('2026-08-24#day');

    const updateByReportKey = vi.fn().mockResolvedValue({});
    await actions.saveOwnerReport('2026-08-24#day', command, {
      create: vi.fn(),
      updateByReportKey,
    });

    expect(updateByReportKey).toHaveBeenCalledOnce();
    expect(updateByReportKey.mock.calls[0]![0]).toBe('2026-08-24#day');
    expect(updateByReportKey.mock.calls[0]![1]).not.toHaveProperty('reportKey');
    expect(updateByReportKey.mock.calls[0]![1]).not.toHaveProperty('businessDate');
    expect(updateByReportKey.mock.calls[0]![1]).not.toHaveProperty('shiftId');
    expect(updateByReportKey.mock.calls[0]![1]).not.toHaveProperty('owner');
    expect(updateByReportKey.mock.calls[0]![1]).not.toHaveProperty('submittedAt');
  });

  it.each([
    ['DATA_UNAUTHORIZED', '権限がありません'],
    ['DATA_NOT_FOUND', '見つかりません'],
    ['DATA_CONFLICT', '競合'],
    ['DATA_PAGINATION_FAILED', '読み込み'],
    ['DATA_NETWORK_ERROR', 'ネットワークエラー'],
  ] as const)('shows a stable %s page message', (code, text) => {
    expect(
      actions.ownerReportDataErrorMessage(
        new DataRepositoryError(code),
        'fallback',
      ),
    ).toContain(text);
  });

  it('clears route state immediately and ignores an older load while the current route is pending', async () => {
    const older = deferred<{ reportKey: string }>();
    const current = deferred<{ reportKey: string }>();
    const state = {
      reportKey: 'stale#report',
      ready: true,
      loading: false,
    };
    const applied: string[] = [];
    const controller = actions.createOwnerReportLoadController<{
      reportKey: string;
    }>({
      reset() {
        state.reportKey = '';
        state.ready = false;
      },
      setLoading(value) {
        state.loading = value;
      },
      apply(value) {
        state.reportKey = value.reportKey;
        state.ready = true;
        applied.push(value.reportKey);
      },
      fail: vi.fn(),
    });

    const olderLoad = controller.load(() => older.promise);
    const currentLoad = controller.load(() => current.promise);

    expect(state).toEqual({ reportKey: '', ready: false, loading: true });
    older.resolve({ reportKey: 'A#day' });
    await olderLoad;
    expect(state).toEqual({ reportKey: '', ready: false, loading: true });
    expect(applied).toEqual([]);

    current.resolve({ reportKey: 'B#day' });
    await currentLoad;
    expect(state).toEqual({ reportKey: 'B#day', ready: true, loading: false });
    expect(applied).toEqual(['B#day']);
  });

  it('keeps a failed current route blank after an older load resolves late', async () => {
    const older = deferred<{ reportKey: string }>();
    const current = deferred<{ reportKey: string }>();
    const state = { reportKey: 'stale#report', ready: true, loading: false };
    const failures: unknown[] = [];
    const controller = actions.createOwnerReportLoadController<{
      reportKey: string;
    }>({
      reset() {
        state.reportKey = '';
        state.ready = false;
      },
      setLoading(value) {
        state.loading = value;
      },
      apply(value) {
        state.reportKey = value.reportKey;
        state.ready = true;
      },
      fail(error) {
        failures.push(error);
      },
    });

    const olderLoad = controller.load(() => older.promise);
    const currentLoad = controller.load(() => current.promise);
    const currentFailure = new DataRepositoryError('DATA_NOT_FOUND');
    current.reject(currentFailure);
    await currentLoad;
    expect(state).toEqual({ reportKey: '', ready: false, loading: false });
    expect(failures).toEqual([currentFailure]);

    older.resolve({ reportKey: 'A#day' });
    await olderLoad;
    expect(state).toEqual({ reportKey: '', ready: false, loading: false });
    expect(failures).toEqual([currentFailure]);
  });

  it('drops a pending load after the report route unmounts', async () => {
    const pending = deferred<{ reportKey: string }>();
    const apply = vi.fn();
    const fail = vi.fn();
    const controller = actions.createOwnerReportLoadController({
      reset: vi.fn(),
      setLoading: vi.fn(),
      apply,
      fail,
    });

    const load = controller.load(() => pending.promise);
    controller.invalidate();
    pending.resolve({ reportKey: 'A#day' });
    await load;

    expect(apply).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it('allows only one pending save and drops stale save callbacks after route invalidation', async () => {
    const pending = deferred<unknown>();
    const save = vi.fn(() => pending.promise);
    const staleFailures: unknown[] = [];
    const savingStates: boolean[] = [];
    const controller = actions.createOwnerReportSaveController({
      setSaving(value) {
        savingStates.push(value);
      },
      succeed: vi.fn(),
      fail(error) {
        staleFailures.push(error);
      },
    });

    const first = controller.run(save);
    const second = await controller.run(save);
    expect(second).toBe(false);
    expect(save).toHaveBeenCalledOnce();
    expect(savingStates).toEqual([true]);

    controller.invalidate();
    const staleFailure = new Error('old route failed');
    pending.reject(staleFailure);
    await first;
    expect(staleFailures).toEqual([]);
    expect(savingStates).toEqual([true, false]);
  });

  it('clears saving after a current failure without reporting success', async () => {
    const failure = new DataRepositoryError('DATA_CONFLICT');
    const failures: unknown[] = [];
    const successes = vi.fn();
    const savingStates: boolean[] = [];
    const controller = actions.createOwnerReportSaveController({
      setSaving(value) {
        savingStates.push(value);
      },
      succeed: successes,
      fail(error) {
        failures.push(error);
      },
    });

    await expect(controller.run(() => Promise.reject(failure))).resolves.toBe(
      false,
    );
    expect(failures).toEqual([failure]);
    expect(successes).not.toHaveBeenCalled();
    expect(savingStates).toEqual([true, false]);
  });

  it('lets a pending confirmation stop before persistence after route invalidation', async () => {
    const confirmation = deferred<void>();
    const persist = vi.fn().mockResolvedValue({});
    let currentCheck: (() => boolean) | undefined;
    const controller = actions.createOwnerReportSaveController({
      setSaving: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
    });

    const submission = controller.run(async (isCurrent) => {
      currentCheck = isCurrent;
      await confirmation.promise;
      if (!isCurrent()) return { saved: false };
      return persist();
    });

    expect(typeof currentCheck).toBe('function');
    controller.invalidate();
    confirmation.resolve();
    await submission;
    expect(persist).not.toHaveBeenCalled();
  });

  it('preserves the historical responsible-person snapshot until its ID changes', () => {
    const existing = {
      responsiblePersonId: 'p1',
      responsiblePersonSnapshot: '历史姓名',
    };

    expect(
      actions.responsiblePersonSnapshot(existing, 'p1', '主数据新姓名'),
    ).toBe('历史姓名');
    expect(
      actions.responsiblePersonSnapshot(existing, 'p2', '李四'),
    ).toBe('李四');
    expect(actions.responsiblePersonSnapshot(null, 'p1', '张三')).toBe('张三');
  });

  it('uses the command snapshot resolver for the responsible person shown on confirmation', () => {
    const existing = {
      responsiblePersonId: 'p1',
      responsiblePersonSnapshot: '历史姓名',
    };
    const persons = [
      { id: 'p1', name: '主数据新姓名' },
      { id: 'p2', name: '李四' },
    ];

    expect(actions.ownerReportPersonName(existing, 'p1', persons)).toBe(
      '历史姓名',
    );
    expect(actions.ownerReportPersonName(existing, 'p2', persons)).toBe(
      '李四',
    );
  });
});
