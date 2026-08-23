import { describe, expect, it, vi } from 'vitest';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('AnalyticsService staff meal summary', () => {
  it('returns raw methods and derived total globally and by shift', async () => {
    const rows = [
      {
        id: 'r1',
        reportDate: '2026-08-23',
        shiftId: 'day',
        shiftNameSnapshot: '白班',
        totalSalesYen: 21_800,
        imosSalesYen: 22_000,
        expenseYen: 1_000,
        cashDepositYen: 15_000,
        deviationYen: 800,
        staffMealCashYen: 1_200,
        staffMealAlipayYen: 800,
        shift: { sortOrder: 2 },
        createdBy: { username: 'kitchen' },
      },
      {
        id: 'r2',
        reportDate: '2026-08-23',
        shiftId: 'night',
        shiftNameSnapshot: '夜班',
        totalSalesYen: 10_000,
        imosSalesYen: 9_000,
        expenseYen: 0,
        cashDepositYen: 10_000,
        deviationYen: 1_000,
        staffMealCashYen: 300,
        staffMealAlipayYen: 500,
        shift: { sortOrder: 3 },
        createdBy: { username: 'kitchen' },
      },
    ];
    const findMany = vi.fn().mockResolvedValue(rows);
    const prisma = {
      dailyReport: { findMany },
    } as unknown as PrismaService;

    const result = await new AnalyticsService(prisma).summary(
      'day',
      '2026-08-23',
    );

    expect(result.totals).toMatchObject({
      staffMealCashYen: 1_500,
      staffMealAlipayYen: 1_300,
      staffMealTotalYen: 2_800,
      totalSalesYen: 31_800,
    });
    expect(result.byShift).toEqual([
      expect.objectContaining({
        shiftId: 'day',
        staffMealCashYen: 1_200,
        staffMealAlipayYen: 800,
        staffMealTotalYen: 2_000,
      }),
      expect.objectContaining({
        shiftId: 'night',
        staffMealCashYen: 300,
        staffMealAlipayYen: 500,
        staffMealTotalYen: 800,
      }),
    ]);
    expect(result.rows[0]).toMatchObject({
      staffMealCashYen: 1_200,
      staffMealAlipayYen: 800,
    });
  });
});
