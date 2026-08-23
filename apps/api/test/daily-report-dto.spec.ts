import 'reflect-metadata';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  CreateDailyReportDto,
  UpdateDailyReportDto,
} from '../src/daily-reports/daily-reports.controller';

function createDto(overrides: Partial<CreateDailyReportDto> = {}) {
  return Object.assign(new CreateDailyReportDto(), {
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
    staffMealCashYen: 0,
    staffMealAlipayYen: 2_000_000_000,
    ...overrides,
  });
}

describe('daily report staff meal DTO', () => {
  it('accepts zero and the exact upper bound', async () => {
    await expect(validate(createDto())).resolves.toHaveLength(0);
  });

  it.each([
    ['staffMealCashYen', -1],
    ['staffMealCashYen', 2_000_000_001],
    ['staffMealAlipayYen', -1],
    ['staffMealAlipayYen', 2_000_000_001],
  ] as const)('rejects %s=%d', async (property, value) => {
    const errors = await validate(createDto({ [property]: value }));
    expect(errors.map((error) => error.property)).toContain(property);
  });

  it('applies the same range to optional update fields', async () => {
    const dto = Object.assign(new UpdateDailyReportDto(), {
      staffMealCashYen: 2_000_000_001,
      staffMealAlipayYen: -1,
    });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property).sort()).toEqual([
      'staffMealAlipayYen',
      'staffMealCashYen',
    ]);
  });
});
