import { describe, expect, it, vi } from 'vitest';
import { DailyReportsService } from '../src/daily-reports/daily-reports.service';
import { PrismaService } from '../src/prisma/prisma.service';

function buildService() {
  const shiftFindFirst = vi.fn();
  const dailyReportFindUnique = vi.fn();
  const prisma = {
    shift: { findFirst: shiftFindFirst },
    dailyReport: { findUnique: dailyReportFindUnique },
  } as unknown as PrismaService;
  return {
    service: new DailyReportsService(prisma),
    shiftFindFirst,
    dailyReportFindUnique,
  };
}

describe('DailyReportsService.businessDayHint', () => {
  it.each(['网管早班', '白班', '网管夜班'])(
    'does not inherit a start time for %s',
    async (name) => {
      const { service, shiftFindFirst, dailyReportFindUnique } = buildService();
      shiftFindFirst.mockResolvedValueOnce({ name });

      await expect(service.businessDayHint('2026-08-05', 'current')).resolves.toEqual({
        previousShiftEndMinute: null,
      });
      expect(shiftFindFirst).toHaveBeenCalledTimes(1);
      expect(dailyReportFindUnique).not.toHaveBeenCalled();
    },
  );

  it('returns the same-day day-shift end time for night shift', async () => {
    const { service, shiftFindFirst, dailyReportFindUnique } = buildService();
    shiftFindFirst
      .mockResolvedValueOnce({ name: '夜班' })
      .mockResolvedValueOnce({ id: 'day-id' });
    dailyReportFindUnique.mockResolvedValueOnce({ endMinuteOfDay: 1020 });

    await expect(service.businessDayHint('2026-08-05', 'night-id')).resolves.toEqual({
      previousShiftEndMinute: 1020,
    });
    expect(shiftFindFirst).toHaveBeenNthCalledWith(2, {
      where: { name: '白班', active: true },
      select: { id: true },
    });
    expect(dailyReportFindUnique).toHaveBeenCalledWith({
      where: {
        reportDate_shiftId: {
          reportDate: '2026-08-05',
          shiftId: 'day-id',
        },
      },
    });
  });

  it('returns null when the day-shift report is missing', async () => {
    const { service, shiftFindFirst, dailyReportFindUnique } = buildService();
    shiftFindFirst
      .mockResolvedValueOnce({ name: '夜班' })
      .mockResolvedValueOnce({ id: 'day-id' });
    dailyReportFindUnique.mockResolvedValueOnce(null);

    await expect(service.businessDayHint('2026-08-05', 'night-id')).resolves.toEqual({
      previousShiftEndMinute: null,
    });
  });

  it('does not query the database for invalid parameters', async () => {
    const { service, shiftFindFirst, dailyReportFindUnique } = buildService();

    await expect(service.businessDayHint('08-05-2026', '')).resolves.toEqual({
      previousShiftEndMinute: null,
    });
    expect(shiftFindFirst).not.toHaveBeenCalled();
    expect(dailyReportFindUnique).not.toHaveBeenCalled();
  });
});
