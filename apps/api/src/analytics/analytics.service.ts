import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { deviationYenFromStoredFields } from '../calc/daily-report-calc';
import { Period, tokyoRange } from './period-range';

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(period: Period, anchorDate: string) {
    const { start, end } = tokyoRange(period, anchorDate);
    const rows = await this.prisma.dailyReport.findMany({
      where: {
        status: 'approved' satisfies Prisma.DailyReportWhereInput['status'],
        reportDate: { gte: start, lte: end },
      },
      include: { shift: true, createdBy: { select: { username: true } } },
      orderBy: [{ reportDate: 'asc' }, { shift: { sortOrder: 'asc' } }],
    });

    const byShift: Record<
      string,
      {
        shiftId: string;
        shiftName: string;
        totalSalesYen: number;
        imosSalesYen: number;
        expenseYen: number;
        cashDepositYen: number;
        deviationYen: number;
        count: number;
      }
    > = {};

    let totalSalesYen = 0;
    let imosSalesYen = 0;
    let expenseYen = 0;
    let cashDepositYen = 0;
    let deviationYen = 0;

    for (const r of rows) {
      const sid = r.shiftId;
      const dev = deviationYenFromStoredFields(r);
      if (!byShift[sid]) {
        byShift[sid] = {
          shiftId: sid,
          shiftName: r.shiftNameSnapshot,
          totalSalesYen: 0,
          imosSalesYen: 0,
          expenseYen: 0,
          cashDepositYen: 0,
          deviationYen: 0,
          count: 0,
        };
      }
      byShift[sid].totalSalesYen += r.totalSalesYen;
      byShift[sid].imosSalesYen += r.imosSalesYen;
      byShift[sid].expenseYen += r.expenseYen;
      byShift[sid].cashDepositYen += r.cashDepositYen;
      byShift[sid].deviationYen += dev;
      byShift[sid].count += 1;
      totalSalesYen += r.totalSalesYen;
      imosSalesYen += r.imosSalesYen;
      expenseYen += r.expenseYen;
      cashDepositYen += r.cashDepositYen;
      deviationYen += dev;
    }

    return {
      period,
      anchorDate,
      range: { start, end },
      totals: {
        totalSalesYen,
        imosSalesYen,
        expenseYen,
        cashDepositYen,
        deviationYen,
      },
      byShift: Object.values(byShift),
      rows,
    };
  }
}
