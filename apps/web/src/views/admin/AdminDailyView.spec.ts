import { describe, expect, it, vi } from 'vitest';

import { DataRepositoryError } from '@/data/errors';
import * as dailyView from './AdminDailyView.vue';

interface DailyLoader {
  loadOwnerDailyReports<T>(options: {
    now?: Date;
    dates?: string[];
    listByBusinessDate(date: string): Promise<Array<T | null>>;
    getSetting(id: string): Promise<{ registerFloatAmount: number }>;
  }): Promise<{ rows: T[]; registerFloatAmount: number }>;
}

const loader = dailyView as unknown as DailyLoader;

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
});
