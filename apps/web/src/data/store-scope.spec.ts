import { describe, expect, it, vi } from 'vitest';
import { createOwnerMasterDataRepository } from './master-data';
import { createDailyReportsRepository } from './daily-reports';
import type { FskDataClient } from './client';

describe('scoped repositories', () => {
 it('binds settings and lists to the selected store', async () => {
   const get = vi.fn().mockResolvedValue({ data: { id: '03_default', registerFloatAmount: 0 } });
   const list = vi.fn().mockResolvedValue({ data: [{ id: '02_day', storeId: '02' }, { id: '03_day', storeId: '03' }] });
   const client = { models: { AppSetting: { get }, ShiftDefinition: { list } } } as unknown as FskDataClient;
   const repo = createOwnerMasterDataRepository(client, '03');
   await repo.getSetting('default');
   expect(get).toHaveBeenCalledWith({ id: '03_default' });
   expect(await repo.listShifts()).toEqual([{ id: '03_day', storeId: '03' }]);
 });
 it('rejects writes across the captured store and writes in all-stores scope', async () => {
   const update = vi.fn();
   const client = { models: { DailyReport: { update } } } as unknown as FskDataClient;
   const repo = createDailyReportsRepository(client, { storeId: '02' });
   await expect(repo.deleteByReportKey('03#2026-11-26#03_day')).rejects.toThrow('STORE_FORBIDDEN');
   const all = createOwnerMasterDataRepository(client, 'all');
   await expect(all.updateSetting({ id: 'default', registerFloatAmount: 10, setupCompleted: true })).rejects.toThrow('STORE_REQUIRED');
   expect(update).not.toHaveBeenCalled();
 });
});
