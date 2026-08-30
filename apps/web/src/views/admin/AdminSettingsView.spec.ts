import { describe, expect, it, vi } from 'vitest';

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
