import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  Max,
} from 'class-validator';
import type { Request } from 'express';
import { Role } from '@prisma/client';
import { DailyReportsService } from './daily-reports.service';
import { Roles } from '../common/decorators/roles.decorator';

class CreateDailyReportDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  reportDate!: string;

  @IsString()
  shiftId!: string;

  @IsString()
  responsiblePersonId!: string;

  @IsInt()
  @Min(0)
  @Max(1439)
  startMinuteOfDay!: number;

  @IsInt()
  @Min(0)
  @Max(1439)
  endMinuteOfDay!: number;

  @IsInt()
  @Min(0)
  previousImosBalanceYen!: number;

  @IsInt()
  @Min(0)
  currentImosBalanceYen!: number;

  @IsInt()
  @Min(0)
  newageYen!: number;

  @IsInt()
  @Min(0)
  cashTotalYen!: number;

  @IsInt()
  @Min(0)
  expenseYen!: number;

  @IsOptional()
  @IsString()
  expenseReason?: string;

  /** 管理员 POST 补录时必填：归属网管的用户 id */
  @IsOptional()
  @IsString()
  createdByUserId?: string;
}

class UpdateDailyReportDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  reportDate?: string;

  @IsOptional()
  @IsString()
  shiftId?: string;

  @IsOptional()
  @IsString()
  responsiblePersonId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1439)
  startMinuteOfDay?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1439)
  endMinuteOfDay?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  previousImosBalanceYen?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  currentImosBalanceYen?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  newageYen?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  cashTotalYen?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  expenseYen?: number;

  @IsOptional()
  @IsString()
  expenseReason?: string;
}

@Controller('daily-reports')
export class DailyReportsController {
  constructor(private readonly svc: DailyReportsService) {}

  private auth(req: Request) {
    const u = req.user as { userId: string; role: Role };
    return { userId: u.userId, role: u.role };
  }

  @Get()
  list(
    @Req() req: Request,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('reportDate') reportDate?: string,
    @Query('limit') limitRaw?: string,
  ) {
    let limit: number | undefined;
    if (limitRaw !== undefined && limitRaw !== '') {
      const n = parseInt(limitRaw, 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new BadRequestException('limit must be a positive integer');
      }
      limit = Math.min(n, 5000);
    }
    return this.svc.list(this.auth(req), { from, to, reportDate, limit });
  }

  /** 使用两段路径，避免被 @Get(':id') 当成 id=business-day-hint → 404 */
  @Get('hint/business-day')
  businessDayHint(
    @Query('reportDate') reportDate: string,
    @Query('shiftId') shiftId: string,
  ) {
    return this.svc.businessDayHint(reportDate, shiftId);
  }

  @Get(':id')
  one(@Req() req: Request, @Param('id') id: string) {
    return this.svc.findOne(this.auth(req), id);
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateDailyReportDto) {
    return this.svc.create(this.auth(req), dto);
  }

  @Put(':id')
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateDailyReportDto,
  ) {
    return this.svc.update(this.auth(req), id, dto);
  }

}
