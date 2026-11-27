// @vitest-environment jsdom

import { createPinia } from 'pinia';
import { computed, createApp, defineComponent, h, inject, nextTick, provide, type App, type ComputedRef, type PropType } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DataRepositoryError } from '@/data/errors';
import * as settingsView from './AdminSettingsView.vue';

interface SettingsActions {
  loadOwnerSettings(repository: {
    getSetting(id: string): Promise<{ registerFloatAmount: number }>;
    listShifts(): Promise<unknown[]>;
    listResponsiblePersons(): Promise<unknown[]>;
  }): Promise<{
    settingExists: boolean;
    registerFloatAmount: number;
    shifts: unknown[];
    persons: unknown[];
  }>;
  updateOwnerShiftActive(
    row: { id: string; name: string; sortOrder: number; active: boolean },
    active: boolean,
    repository: {
      updateShift(value: unknown): Promise<unknown>;
      deleteShift(id: string): Promise<unknown>;
    },
  ): Promise<unknown>;
  updateOwnerPersonActive(
    row: { id: string; name: string; active: boolean },
    active: boolean,
    repository: {
      updateResponsiblePerson(value: unknown): Promise<unknown>;
      deleteResponsiblePerson(id: string): Promise<unknown>;
    },
  ): Promise<unknown>;
}

const actions = settingsView as unknown as SettingsActions;

describe('OWNER settings repository actions', () => {
  it('initializes a missing AppSetting/default while still loading paginated master lists', async () => {
    const listShifts = vi.fn().mockResolvedValue([{ id: 'day', active: true }]);
    const listResponsiblePersons = vi
      .fn()
      .mockResolvedValue([{ id: 'p1', active: true }]);

    const result = await actions.loadOwnerSettings({
      getSetting: vi
        .fn()
        .mockRejectedValue(new DataRepositoryError('DATA_NOT_FOUND')),
      listShifts,
      listResponsiblePersons,
    });

    expect(result).toEqual({
      settingExists: false,
      registerFloatAmount: 0,
      shifts: [{ id: 'day', active: true }],
      persons: [{ id: 'p1', active: true }],
    });
    expect(listShifts).toHaveBeenCalledOnce();
    expect(listResponsiblePersons).toHaveBeenCalledOnce();
  });

  it('deactivates a shift with active=false and never deletes historical master data', async () => {
    const updateShift = vi.fn().mockResolvedValue({});
    const deleteShift = vi.fn();
    const row = { id: 'day', name: '日班', sortOrder: 10, active: true };

    await actions.updateOwnerShiftActive(row, false, {
      updateShift,
      deleteShift,
    });

    expect(updateShift).toHaveBeenCalledWith({ ...row, active: false });
    expect(deleteShift).not.toHaveBeenCalled();
  });

  it('deactivates a responsible person with active=false and never deletes its snapshot name', async () => {
    const updateResponsiblePerson = vi.fn().mockResolvedValue({});
    const deleteResponsiblePerson = vi.fn();
    const row = { id: 'p1', name: '张三', active: true };

    await actions.updateOwnerPersonActive(row, false, {
      updateResponsiblePerson,
      deleteResponsiblePerson,
    });

    expect(updateResponsiblePerson).toHaveBeenCalledWith({
      ...row,
      active: false,
    });
    expect(deleteResponsiblePerson).not.toHaveBeenCalled();
  });
});


const repositoryMocks = vi.hoisted(() => ({
  getSetting: vi.fn(), listShifts: vi.fn(), listResponsiblePersons: vi.fn(),
  deleteShift: vi.fn(), deleteResponsiblePerson: vi.fn(),
}));
const messages = vi.hoisted(() => ({ confirm: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/data/master-data', () => ({ createOwnerMasterDataRepository: () => repositoryMocks }));
vi.mock('element-plus', () => ({
  ElMessageBox: { confirm: messages.confirm },
  ElMessage: { success: messages.success, error: messages.error },
}));

const tableRowsKey = Symbol('masterRows');
const TableStub = defineComponent({
  props: { data: { type: Array as PropType<Array<Record<string, unknown>>>, default: () => [] } },
  setup(props, { slots, attrs }) {
    provide(tableRowsKey, computed(() => props.data));
    return () => h('div', attrs, slots.default?.());
  },
});
const TableColumnStub = defineComponent({
  setup(_props, { slots }) {
    const rows = inject<ComputedRef<Array<Record<string, unknown>>>>(tableRowsKey, computed(() => []));
    return () => h('div', rows.value.flatMap((row) => slots.default?.({ row }) ?? []));
  },
});
const ButtonStub = defineComponent({
  props: { loading: Boolean },
  setup(props, { attrs, slots }) {
    return () => h('button', { ...attrs, 'aria-busy': String(props.loading) }, slots.default?.());
  },
});
const InputStub = defineComponent({ setup: () => () => h('input') });
const mountedApps = new Set<App>();
async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); await nextTick(); }
async function mountSettings() {
  const root = document.createElement('div');
  const app = createApp(settingsView.default);
  app.use(createPinia());
  app.component('ElTable', TableStub);
  app.component('ElTableColumn', TableColumnStub);
  app.component('ElButton', ButtonStub);
  app.component('ElInput', InputStub);
  app.component('ElInputNumber', InputStub);
  app.directive('loading', {});
  app.mount(root); mountedApps.add(app);
  await settle();
  return { root, app };
}
function deleteButton(root: HTMLElement, selector: string, name: string): HTMLButtonElement {
  const button = root.querySelector<HTMLButtonElement>(`${selector} button[aria-label="${name}を削除"]`);
  if (!button) throw new Error('DELETE_BUTTON_NOT_FOUND');
  return button;
}

beforeEach(() => {
  vi.clearAllMocks();
  repositoryMocks.getSetting.mockResolvedValue({ registerFloatAmount: 5000 });
  repositoryMocks.listShifts.mockResolvedValue([
    { id: '02_day', name: '日班', sortOrder: 10, active: true },
    { id: '02_night', name: '夜班', sortOrder: 20, active: false },
  ]);
  repositoryMocks.listResponsiblePersons.mockResolvedValue([
    { id: '02_p1', name: '担当者一', active: true },
    { id: '02_p2', name: '担当者二', active: false },
  ]);
  repositoryMocks.deleteShift.mockResolvedValue({});
  repositoryMocks.deleteResponsiblePerson.mockResolvedValue({});
  messages.confirm.mockResolvedValue('confirm');
});
afterEach(() => { for (const app of mountedApps) app.unmount(); mountedApps.clear(); });

const masterCases = [
  { name: '日班', id: '02_day', method: 'deleteShift' as const, other: '夜班' },
  { name: '担当者一', id: '02_p1', method: 'deleteResponsiblePerson' as const, other: '担当者二' },
];
describe('OWNER master deletion', () => {
  it.each(masterCases.flatMap((entry) => ['.settings-table', '.mobile-master-list'].map((selector) => ({ ...entry, selector }))))(
    'confirms and removes only $name from $selector', async ({ name, id, method, other, selector }) => {
      const { root } = await mountSettings();
      deleteButton(root, selector, name).click(); await settle();
      expect(messages.confirm.mock.calls[0]?.[0]).toContain(`「${name}」`);
      expect(messages.confirm.mock.calls[0]?.[0]).toContain('既存の日報');
      expect(repositoryMocks[method]).toHaveBeenCalledExactlyOnceWith(id);
      expect(root.querySelector(`button[aria-label="${name}を削除"]`)).toBeNull();
      expect(deleteButton(root, selector, other)).toBeTruthy();
      expect(messages.success).toHaveBeenCalledOnce();
    },
  );
  it.each(masterCases)('does not delete $name when confirmation is cancelled', async ({ name, method }) => {
    messages.confirm.mockRejectedValue('cancel');
    const { root } = await mountSettings();
    deleteButton(root, '.mobile-master-list', name).click(); await settle();
    expect(repositoryMocks[method]).not.toHaveBeenCalled();
    expect(deleteButton(root, '.mobile-master-list', name).disabled).toBe(false);
    expect(messages.error).not.toHaveBeenCalled();
  });
  it.each(masterCases)('keeps $name visible when deletion fails', async ({ name, method }) => {
    repositoryMocks[method].mockRejectedValue(new DataRepositoryError('DATA_NETWORK_ERROR'));
    const { root } = await mountSettings();
    deleteButton(root, '.mobile-master-list', name).click(); await settle();
    expect(deleteButton(root, '.mobile-master-list', name).disabled).toBe(false);
    expect(messages.error).toHaveBeenCalledOnce();
    expect(messages.success).not.toHaveBeenCalled();
  });
  it('blocks duplicate or competing deletes while a request is pending', async () => {
    let release!: (value: object) => void;
    repositoryMocks.deleteShift.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const { root } = await mountSettings();
    const button = deleteButton(root, '.mobile-master-list', '日班');
    button.click(); await settle();
    button.click();
    deleteButton(root, '.mobile-master-list', '担当者一').click(); await settle();
    expect(repositoryMocks.deleteShift).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.deleteResponsiblePerson).not.toHaveBeenCalled();
    release({}); await settle();
  });
  it('does not delete from the old store after leaving a pending confirmation', async () => {
    let confirm!: (value: string) => void;
    messages.confirm.mockReturnValue(new Promise((resolve) => { confirm = resolve; }));
    const { root, app } = await mountSettings();
    deleteButton(root, '.mobile-master-list', '日班').click(); await settle();
    app.unmount(); mountedApps.delete(app);
    confirm('confirm'); await settle();
    expect(repositoryMocks.deleteShift).not.toHaveBeenCalled();
  });
});
