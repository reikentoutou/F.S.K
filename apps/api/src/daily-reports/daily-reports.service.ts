import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { computeDailyReportTotals } from '../calc/daily-report-calc';
import { assertValidRange, labelFromMinutes } from './time-range';

export type AuthUser = { userId: string; role: Role };

@Injectable()
export class DailyReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private computeAndValidate(
    data: {
      previousImosBalanceYen: number;
      currentImosBalanceYen: number;
      newageYen: number;
      cashTotalYen: number;
      expenseYen: number;
      expenseReason: string | null | undefined;
    },
    registerFloatYen: number,
  ) {
    const reason = data.expenseReason?.trim();
    if (data.expenseYen > 0 && !reason) {
      throw new BadRequestException('expenseReason is required');
    }
    return computeDailyReportTotals({
      previousImosBalanceYen: data.previousImosBalanceYen,
      currentImosBalanceYen: data.currentImosBalanceYen,
      newageYen: data.newageYen,
      cashTotalYen: data.cashTotalYen,
      expenseYen: data.expenseYen,
      registerFloatYen,
    });
  }

  async create(
    user: AuthUser,
    dto: {
      reportDate: string;
      shiftId: string;
      responsiblePersonId: string;
      startMinuteOfDay: number;
      endMinuteOfDay: number;
      previousImosBalanceYen: number;
      currentImosBalanceYen: number;
      newageYen: number;
      cashTotalYen: number;
      expenseYen: number;
      expenseReason?: string;
      createdByUserId?: string;
    },
  ) {
    assertValidRange(dto.startMinuteOfDay, dto.endMinuteOfDay);
    let createdByUserId = user.userId;
    if (user.role === Role.ADMIN) {
      if (!dto.createdByUserId) {
        throw new BadRequestException('createdByUserId required for admin POST');
      }
      const wm = await this.prisma.user.findFirst({
        where: { id: dto.createdByUserId, role: Role.WEBMASTER },
      });
      if (!wm) throw new BadRequestException('createdByUserId must be WEBMASTER');
      createdByUserId = dto.createdByUserId;
    }

    const [shift, person] = await Promise.all([
      this.prisma.shift.findUnique({ where: { id: dto.shiftId } }),
      this.prisma.responsiblePerson.findFirst({
        where: { id: dto.responsiblePersonId, active: true },
      }),
    ]);
    if (!shift?.active) throw new BadRequestException('Invalid shift');
    if (!person) throw new BadRequestException('Invalid responsible person');

    const settings = await this.prisma.appSettings.findUnique({
      where: { id: 'default' },
    });
    const registerFloatYen = settings?.registerFloatAmount ?? 0;

    const computed = this.computeAndValidate(
      {
        previousImosBalanceYen: dto.previousImosBalanceYen,
        currentImosBalanceYen: dto.currentImosBalanceYen,
        newageYen: dto.newageYen,
        cashTotalYen: dto.cashTotalYen,
        expenseYen: dto.expenseYen,
        expenseReason: dto.expenseReason,
      },
      registerFloatYen,
    );

    const existing = await this.prisma.dailyReport.findUnique({
      where: {
        reportDate_shiftId: {
          reportDate: dto.reportDate,
          shiftId: dto.shiftId,
        },
      },
    });
    if (existing) {
      throw new BadRequestException('Report already exists for this date/shift');
    }

    return this.prisma.dailyReport.create({
      data: {
        reportDate: dto.reportDate,
        shiftId: dto.shiftId,
        shiftNameSnapshot: shift.name,
        responsiblePersonId: person.id,
        responsiblePersonSnapshot: person.name,
        startMinuteOfDay: dto.startMinuteOfDay,
        endMinuteOfDay: dto.endMinuteOfDay,
        timeRangeLabelSnapshot: labelFromMinutes(
          dto.startMinuteOfDay,
          dto.endMinuteOfDay,
        ),
        previousImosBalanceYen: dto.previousImosBalanceYen,
        currentImosBalanceYen: dto.currentImosBalanceYen,
        newageYen: dto.newageYen,
        cashTotalYen: dto.cashTotalYen,
        expenseYen: dto.expenseYen,
        expenseReason: dto.expenseReason?.trim() || null,
        ...computed,
        status: 'approved',
        createdByUserId,
      },
    });
  }

  async update(
    user: AuthUser,
    id: string,
    dto: Partial<{
      reportDate: string;
      shiftId: string;
      responsiblePersonId: string;
      startMinuteOfDay: number;
      endMinuteOfDay: number;
      previousImosBalanceYen: number;
      currentImosBalanceYen: number;
      newageYen: number;
      cashTotalYen: number;
      expenseYen: number;
      expenseReason?: string;
    }>,
  ) {
    const row = await this.prisma.dailyReport.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    if (user.role === Role.WEBMASTER) {
      throw new ForbiddenException('Submitted reports cannot be edited');
    }

    const next = {
      reportDate: dto.reportDate ?? row.reportDate,
      shiftId: dto.shiftId ?? row.shiftId,
      responsiblePersonId: dto.responsiblePersonId ?? row.responsiblePersonId,
      startMinuteOfDay: dto.startMinuteOfDay ?? row.startMinuteOfDay,
      endMinuteOfDay: dto.endMinuteOfDay ?? row.endMinuteOfDay,
      previousImosBalanceYen:
        dto.previousImosBalanceYen ?? row.previousImosBalanceYen,
      currentImosBalanceYen:
        dto.currentImosBalanceYen ?? row.currentImosBalanceYen,
      newageYen: dto.newageYen ?? row.newageYen,
      cashTotalYen: dto.cashTotalYen ?? row.cashTotalYen,
      expenseYen: dto.expenseYen ?? row.expenseYen,
      expenseReason:
        dto.expenseReason !== undefined ? dto.expenseReason : row.expenseReason,
    };

    assertValidRange(next.startMinuteOfDay, next.endMinuteOfDay);

    const shift = await this.prisma.shift.findUnique({
      where: { id: next.shiftId },
    });
    const person = await this.prisma.responsiblePerson.findUnique({
      where: { id: next.responsiblePersonId },
    });
    if (!shift?.active) throw new BadRequestException('Invalid shift');
    if (!person?.active) throw new BadRequestException('Invalid responsible person');

    const settings = await this.prisma.appSettings.findUnique({
      where: { id: 'default' },
    });
    const registerFloatYen = settings?.registerFloatAmount ?? 0;

    const computed = this.computeAndValidate(
      {
        previousImosBalanceYen: next.previousImosBalanceYen,
        currentImosBalanceYen: next.currentImosBalanceYen,
        newageYen: next.newageYen,
        cashTotalYen: next.cashTotalYen,
        expenseYen: next.expenseYen,
        expenseReason: next.expenseReason,
      },
      registerFloatYen,
    );

    const conflict = await this.prisma.dailyReport.findFirst({
      where: {
        reportDate: next.reportDate,
        shiftId: next.shiftId,
        NOT: { id },
      },
    });
    if (conflict) {
      throw new BadRequestException('Another report exists for this date/shift');
    }

    return this.prisma.dailyReport.update({
      where: { id },
      data: {
        reportDate: next.reportDate,
        shiftId: next.shiftId,
        shiftNameSnapshot: shift.name,
        responsiblePersonId: person.id,
        responsiblePersonSnapshot: person.name,
        startMinuteOfDay: next.startMinuteOfDay,
        endMinuteOfDay: next.endMinuteOfDay,
        timeRangeLabelSnapshot: labelFromMinutes(
          next.startMinuteOfDay,
          next.endMinuteOfDay,
        ),
        previousImosBalanceYen: next.previousImosBalanceYen,
        currentImosBalanceYen: next.currentImosBalanceYen,
        newageYen: next.newageYen,
        cashTotalYen: next.cashTotalYen,
        expenseYen: next.expenseYen,
        expenseReason: next.expenseReason?.trim() || null,
        ...computed,
      },
    });
  }

  async findOne(user: AuthUser, id: string) {
    const row = await this.prisma.dailyReport.findFirst({
      where: {
        id,
        ...(user.role === Role.WEBMASTER
          ? { createdByUserId: user.userId }
          : {}),
      },
      include: { shift: true, createdBy: { select: { id: true, username: true } } },
    });
    if (!row) throw new NotFoundException();
    return row;
  }

  list(
    user: AuthUser,
    q: { from?: string; to?: string; reportDate?: string; limit?: number },
  ) {
    const where: {
      createdByUserId?: string;
      reportDate?: string | { gte?: string; lte?: string };
    } = {};
    if (user.role === Role.WEBMASTER) {
      where.createdByUserId = user.userId;
    }
    if (q.reportDate) {
      where.reportDate = q.reportDate;
    } else if (q.from || q.to) {
      where.reportDate = {};
      if (q.from) where.reportDate.gte = q.from;
      if (q.to) where.reportDate.lte = q.to;
    }
    return this.prisma.dailyReport.findMany({
      where,
      orderBy: [{ reportDate: 'desc' }, { shift: { sortOrder: 'asc' } }],
      include: {
        shift: true,
        createdBy: { select: { id: true, username: true, role: true } },
      },
      ...(q.limit != null ? { take: q.limit } : {}),
    });
  }

  /**
   * 业务日 = 当日白班→夜班。默认开始时间取同一 reportDate 内上一班的结束时刻；
   * 首班没有上一班，不跨日回看。不按填报人过滤，以便网管在管理员已代填上一班次时仍能带出时间。
   */
  async businessDayHint(reportDate: string, shiftId: string) {
    if (!reportDate?.match(/^\d{4}-\d{2}-\d{2}$/) || !shiftId) {
      return { previousShiftEndMinute: null as number | null };
    }
    const shifts = await this.prisma.shift.findMany({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
    });
    const idx = shifts.findIndex((s) => s.id === shiftId);
    if (idx < 0 || shifts.length === 0) {
      return { previousShiftEndMinute: null as number | null };
    }

    if (idx === 0) {
      return { previousShiftEndMinute: null as number | null };
    }
    const prevShiftId = shifts[idx - 1]!.id;

    const row = await this.prisma.dailyReport.findUnique({
      where: {
        reportDate_shiftId: { reportDate, shiftId: prevShiftId },
      },
    });
    if (!row) return { previousShiftEndMinute: null as number | null };
    return { previousShiftEndMinute: row.endMinuteOfDay };
  }
}
