import { Role } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { DailyReportsService } from '../src/daily-reports/daily-reports.service';
import { PrismaService } from '../src/prisma/prisma.service';

type StoredReport = Record<string, unknown> & { id: string };

function createHarness(initialReport: StoredReport | null = null) {
  let storedReport = initialReport;
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    storedReport = { id: 'report-1', ...data };
    return storedReport;
  });
  const update = vi.fn(
    async ({ data }: { where: { id: string }; data: Record<string, unknown> }) => {
      storedReport = { ...(storedReport ?? { id: 'report-1' }), ...data };
      return storedReport;
    },
  );
  const dailyReportFindUnique = vi.fn(
    async (args: { where: Record<string, unknown> }) =>
      'id' in args.where ? storedReport : null,
  );
  const prisma = {
    user: { findFirst: vi.fn() },
    shift: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: 'shift-1', name: '白班', active: true }),
    },
    responsiblePerson: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 'person-1', name: '厨房', active: true }),
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: 'person-1', name: '厨房', active: true }),
    },
    appSettings: {
      findUnique: vi.fn().mockResolvedValue({ registerFloatAmount: 5_000 }),
    },
    dailyReport: {
      findUnique: dailyReportFindUnique,
      findFirst: vi.fn().mockResolvedValue(null),
      create,
      update,
    },
  } as unknown as PrismaService;
  return { service: new DailyReportsService(prisma), create, update };
}

const baseDto = {
  reportDate: '2026-08-23',
  shiftId: 'shift-1',
  responsiblePersonId: 'person-1',
  startMinuteOfDay: 540,
  endMinuteOfDay: 1080,
  previousImosBalanceYen: 10_000,
  currentImosBalanceYen: 32_000,
  newageYen: 8_000,
  cashTotalYen: 20_000,
  expenseYen: 1_000,
  expenseReason: '備品',
  staffMealCashYen: 1_200,
  staffMealAlipayYen: 800,
};

describe('DailyReportsService staff meals', () => {
  it('persists both raw fields and overwrites forged derived amounts on create', async () => {
    const { service, create } = createHarness();
    const forged = {
      ...baseDto,
      totalSalesYen: 999_999,
      cashDepositYen: 999_999,
      deviationYen: 999_999,
      staffMealTotalYen: 999_999,
    };

    const result = await service.create(
      { userId: 'wm-1', role: Role.WEBMASTER },
      forged,
    );

    expect(result).toEqual(
      expect.objectContaining({
        staffMealCashYen: 1_200,
        staffMealAlipayYen: 800,
        cashDepositYen: 15_000,
        totalSalesYen: 21_800,
        deviationYen: 800,
      }),
    );
    expect(result).not.toHaveProperty('staffMealTotalYen');
    expect(create.mock.calls[0]?.[0].data).not.toHaveProperty(
      'staffMealTotalYen',
    );
  });

  it('uses stored values for omitted update fields and recalculates after a cash-meal edit', async () => {
    const { service } = createHarness({
      id: 'report-1',
      ...baseDto,
      shiftNameSnapshot: '白班',
      responsiblePersonSnapshot: '厨房',
      timeRangeLabelSnapshot: '09:00 - 18:00',
      imosSalesYen: 22_000,
      totalSalesYen: 21_800,
      cashDepositYen: 15_000,
      deviationYen: 800,
      status: 'approved',
      createdByUserId: 'wm-1',
    });

    const result = await service.update(
      { userId: 'admin-1', role: Role.ADMIN },
      'report-1',
      { staffMealCashYen: 2_000 },
    );

    expect(result).toEqual(
      expect.objectContaining({
        staffMealCashYen: 2_000,
        staffMealAlipayYen: 800,
        cashDepositYen: 15_000,
        totalSalesYen: 21_000,
        deviationYen: 0,
      }),
    );
  });
});
