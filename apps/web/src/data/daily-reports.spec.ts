import { beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type {
  CreateDailyReportCommand,
  UpdateDailyReportCommand,
} from './daily-reports';

interface RepositoryError extends Error {
  readonly code: string;
  readonly cause?: unknown;
}

interface DailyReportsModule {
  createDailyReportsRepository(
    client: unknown,
    options?: { now?: () => Date },
  ): {
    create(command: CreateDailyReportCommand): Promise<Record<string, unknown>>;
    listByBusinessDate(businessDate: string): Promise<Array<Record<string, unknown>>>;
    getByReportKey(reportKey: string): Promise<Record<string, unknown>>;
    updateByReportKey(
      reportKey: string,
      command: UpdateDailyReportCommand,
    ): Promise<Record<string, unknown>>;
  };
}

let dailyReportsModule: DailyReportsModule | undefined;
let moduleLoadError: unknown;

beforeAll(async () => {
  try {
    dailyReportsModule = (await import('./daily-reports')) as DailyReportsModule;
  } catch (error) {
    moduleLoadError = error;
  }
});

const command: CreateDailyReportCommand = {
  businessDate: '2026-08-24',
  shiftId: 'shift-day',
  shiftNameSnapshot: '日班',
  responsiblePersonId: 'person-1',
  responsiblePersonSnapshot: '张三',
  startMinuteOfDay: 540,
  endMinuteOfDay: 1020,
  timeRangeLabelSnapshot: '09:00-17:00',
  previousImosBalanceYen: 100_000,
  currentImosBalanceYen: 120_000,
  newageYen: 8_000,
  cashTotalYen: 20_000,
  expenseYen: 500,
  expenseReason: '消耗品',
  staffMealCashYen: 1_200,
  staffMealAlipayYen: 800,
  attachmentKeys: ['submissions/sub-a/draft-1/att-1/票据.jpg'],
};

const createdReport = {
  reportKey: '2026-08-24#shift-day',
  ...command,
  submittedAt: '2026-08-24T10:11:12.000Z',
  createdAt: '2026-08-24T10:11:13.000Z',
  updatedAt: '2026-08-24T10:11:13.000Z',
};

function loadedModule(): DailyReportsModule {
  expect(moduleLoadError).toBeUndefined();
  expect(dailyReportsModule).toBeDefined();
  return dailyReportsModule!;
}

function caughtError(value: unknown): RepositoryError {
  expect(value).toBeInstanceOf(Error);
  return value as RepositoryError;
}

describe('daily reports repository', () => {
  it('constructs the deterministic key and timestamp without sending authority or derived totals', async () => {
    const create = vi.fn().mockResolvedValue({ data: createdReport, errors: [] });
    const repository = loadedModule().createDailyReportsRepository(
      {
        models: {
          DailyReport: {
            create,
            dailyReportsByBusinessDate: vi.fn(),
            list: vi.fn(),
          },
        },
      },
      { now: () => new Date('2026-08-24T10:11:12.000Z') },
    );

    const result = await repository.create({
      ...command,
      owner: 'forged-owner',
      role: 'OWNER',
      staffMealTotalYen: 2_000,
      imosSalesYen: 20_000,
      cashDepositYen: 15_000,
      totalSalesYen: 21_800,
      deviationYen: 2_300,
    } as CreateDailyReportCommand);

    expect(result).toEqual(createdReport);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(createdReportInput());
    expect(Object.keys(create.mock.calls[0]![0])).not.toEqual(
      expect.arrayContaining([
        'owner',
        'role',
        'staffMealTotalYen',
        'imosSalesYen',
        'cashDepositYen',
        'totalSalesYen',
        'deviationYen',
      ]),
    );
    expectTypeOf<CreateDailyReportCommand>().not.toHaveProperty('owner');
    expectTypeOf<CreateDailyReportCommand>().not.toHaveProperty('role');
    expectTypeOf<CreateDailyReportCommand>().not.toHaveProperty(
      'staffMealTotalYen',
    );
    expectTypeOf<CreateDailyReportCommand>().not.toHaveProperty('imosSalesYen');
    expectTypeOf<CreateDailyReportCommand>().not.toHaveProperty('cashDepositYen');
    expectTypeOf<CreateDailyReportCommand>().not.toHaveProperty('totalSalesYen');
    expectTypeOf<CreateDailyReportCommand>().not.toHaveProperty('deviationYen');
  });

  it.each([
    [[{ errorType: 'DynamoDB:ConditionalCheckFailedException', message: 'condition failed' }]],
    [[{ extensions: { code: 'DuplicateKey' }, message: 'duplicate report' }]],
    [[{ name: 'AlreadyExistsException', message: 'record exists' }]],
  ])('maps conditional and duplicate GraphQL errors to REPORT_ALREADY_EXISTS', async (errors) => {
    const repository = loadedModule().createDailyReportsRepository({
      models: {
        DailyReport: {
          create: vi.fn().mockResolvedValue({ data: null, errors }),
          dailyReportsByBusinessDate: vi.fn(),
        },
      },
    });

    const error = caughtError(await repository.create(command).catch((caught) => caught));

    expect(error.code).toBe('REPORT_ALREADY_EXISTS');
    expect(error.message).toBe('REPORT_ALREADY_EXISTS');
    expect(error.cause).toBe(errors);
  });

  it.each([
    [[{ message: 'generic duplicate report' }]],
    [[{ errorType: 'ResolverError', message: 'generic conflict' }]],
    [[{ extensions: { code: 'CONFLICT' }, message: 'conflict' }]],
    [[{
      errorType: 'ResolverError',
      message: 'request rejected',
      request: { payload: { expenseReason: 'duplicate conflict already exists' } },
    }]],
  ])('keeps untrusted duplicate/conflict text as an unknown submission result', async (errors) => {
    const repository = loadedModule().createDailyReportsRepository({
      models: {
        DailyReport: {
          create: vi.fn().mockResolvedValue({ data: null, errors }),
          dailyReportsByBusinessDate: vi.fn(),
        },
      },
    });

    const error = caughtError(await repository.create(command).catch((caught) => caught));

    expect(error.code).toBe('SUBMISSION_RESULT_UNKNOWN');
    expect(error.cause).toBe(errors);
  });

  it('maps a network failure to an unknown submission result without exposing its payload', async () => {
    const cause = Object.assign(new TypeError('Failed to fetch secret=card-number'), {
      request: command,
    });
    const repository = loadedModule().createDailyReportsRepository({
      models: {
        DailyReport: {
          create: vi.fn().mockRejectedValue(cause),
          dailyReportsByBusinessDate: vi.fn(),
        },
      },
    });

    const error = caughtError(await repository.create(command).catch((caught) => caught));

    expect(error.code).toBe('SUBMISSION_RESULT_UNKNOWN');
    expect(error.message).toBe('SUBMISSION_RESULT_UNKNOWN');
    expect(error.message).not.toContain('card-number');
    expect(error.cause).toBe(cause);
  });

  it('maps a resolved structured authorization failure to DATA_UNAUTHORIZED', async () => {
    const errors = [
      { errorType: 'UnauthorizedException', message: 'denied secret=payload' },
    ];
    const repository = loadedModule().createDailyReportsRepository({
      models: {
        DailyReport: {
          create: vi.fn().mockResolvedValue({ data: createdReport, errors }),
          dailyReportsByBusinessDate: vi.fn(),
        },
      },
    });

    const error = caughtError(
      await repository.create(command).catch((caught) => caught),
    );

    expect(error.code).toBe('DATA_UNAUTHORIZED');
    expect(error.message).toBe('DATA_UNAUTHORIZED');
    expect(error.message).not.toContain('payload');
    expect(error.cause).toBe(errors);
  });

  it('treats unclassified GraphQL errors and an empty successful result as unknown submission outcomes', async () => {
    const graphQLErrors = [
      { errorType: 'ResolverError', message: 'denied secret=payload' },
    ];
    const create = vi
      .fn()
      .mockResolvedValueOnce({ data: createdReport, errors: graphQLErrors })
      .mockResolvedValueOnce({ data: null, errors: [] });
    const repository = loadedModule().createDailyReportsRepository({
      models: {
        DailyReport: { create, dailyReportsByBusinessDate: vi.fn() },
      },
    });

    const graphQLError = caughtError(
      await repository.create(command).catch((caught) => caught),
    );
    const emptyResultError = caughtError(
      await repository.create(command).catch((caught) => caught),
    );

    expect(graphQLError.code).toBe('SUBMISSION_RESULT_UNKNOWN');
    expect(graphQLError.cause).toBe(graphQLErrors);
    expect(graphQLError.message).not.toContain('payload');
    expect(emptyResultError.code).toBe('SUBMISSION_RESULT_UNKNOWN');
  });

  it('queries every page through the business-date index and never calls a table list', async () => {
    const first = { ...createdReport, reportKey: '2026-08-24#shift-day' };
    const second = { ...createdReport, reportKey: '2026-08-24#shift-night' };
    const dailyReportsByBusinessDate = vi
      .fn()
      .mockResolvedValueOnce({ data: [first], nextToken: 'page-2', errors: [] })
      .mockResolvedValueOnce({ data: [second], nextToken: null, errors: [] });
    const list = vi.fn(() => {
      throw new Error('full table list must not be used');
    });
    const repository = loadedModule().createDailyReportsRepository({
      models: {
        DailyReport: {
          create: vi.fn(),
          dailyReportsByBusinessDate,
          list,
        },
      },
    });

    await expect(repository.listByBusinessDate('2026-08-24')).resolves.toEqual([
      first,
      second,
    ]);
    expect(dailyReportsByBusinessDate).toHaveBeenNthCalledWith(
      1,
      { businessDate: '2026-08-24' },
      undefined,
    );
    expect(dailyReportsByBusinessDate).toHaveBeenNthCalledWith(
      2,
      { businessDate: '2026-08-24' },
      { nextToken: 'page-2' },
    );
    expect(list).not.toHaveBeenCalled();
  });

  it('gets by reportKey and updates only editable fields using the method identifier', async () => {
    const get = vi.fn().mockResolvedValue({ data: createdReport, errors: [] });
    const update = vi.fn().mockResolvedValue({ data: createdReport, errors: [] });
    const repository = loadedModule().createDailyReportsRepository({
      models: {
        DailyReport: {
          create: vi.fn(),
          get,
          update,
          dailyReportsByBusinessDate: vi.fn(),
        },
      },
    });
    const editable = {
      shiftNameSnapshot: '日班（修正）',
      responsiblePersonId: 'person-2',
      responsiblePersonSnapshot: '李四',
      startMinuteOfDay: 545,
      endMinuteOfDay: 1025,
      timeRangeLabelSnapshot: '09:05-17:05',
      previousImosBalanceYen: 101_000,
      currentImosBalanceYen: 121_000,
      newageYen: 8_500,
      cashTotalYen: 20_500,
      expenseYen: 600,
      expenseReason: '消耗品修正',
      staffMealCashYen: 1_300,
      staffMealAlipayYen: 900,
      attachmentKeys: ['daily-reports/report-1/att-1/票据.jpg'],
    };

    await repository.getByReportKey('2026-08-24#shift-day');
    await repository.updateByReportKey('2026-08-24#shift-day', {
      ...editable,
      reportKey: 'forged-key',
      businessDate: '2099-01-01',
      shiftId: 'forged-shift',
      owner: 'forged-owner',
      submittedAt: '2099-01-01T00:00:00.000Z',
      staffMealTotalYen: 2_200,
      imosSalesYen: 20_000,
      cashDepositYen: 15_500,
      totalSalesYen: 21_700,
      deviationYen: 2_300,
    } as UpdateDailyReportCommand);

    expect(get).toHaveBeenCalledWith({
      reportKey: '2026-08-24#shift-day',
    });
    expect(update).toHaveBeenCalledWith({
      reportKey: '2026-08-24#shift-day',
      ...editable,
    });
    expectTypeOf<UpdateDailyReportCommand>().not.toHaveProperty('reportKey');
    expectTypeOf<UpdateDailyReportCommand>().not.toHaveProperty('businessDate');
    expectTypeOf<UpdateDailyReportCommand>().not.toHaveProperty('shiftId');
    expectTypeOf<UpdateDailyReportCommand>().not.toHaveProperty('owner');
    expectTypeOf<UpdateDailyReportCommand>().not.toHaveProperty('submittedAt');
    expectTypeOf<UpdateDailyReportCommand>().not.toHaveProperty(
      'staffMealTotalYen',
    );
    expectTypeOf<UpdateDailyReportCommand>().not.toHaveProperty('imosSalesYen');
    expectTypeOf<UpdateDailyReportCommand>().not.toHaveProperty('cashDepositYen');
    expectTypeOf<UpdateDailyReportCommand>().not.toHaveProperty('totalSalesYen');
    expectTypeOf<UpdateDailyReportCommand>().not.toHaveProperty('deviationYen');
  });

  it.each(['get', 'update'])('rejects %s Data errors even when a record is present', async (operation) => {
    const errors = [{ errorType: 'ResolverError', message: 'partial owner result' }];
    const get = vi.fn().mockResolvedValue({ data: createdReport, errors: [] });
    const update = vi.fn().mockResolvedValue({ data: createdReport, errors: [] });
    (operation === 'get' ? get : update).mockResolvedValue({
      data: createdReport,
      errors,
    });
    const repository = loadedModule().createDailyReportsRepository({
      models: {
        DailyReport: {
          create: vi.fn(),
          get,
          update,
          dailyReportsByBusinessDate: vi.fn(),
        },
      },
    });

    const promise =
      operation === 'get'
        ? repository.getByReportKey('2026-08-24#shift-day')
        : repository.updateByReportKey('2026-08-24#shift-day', {
            shiftNameSnapshot: command.shiftNameSnapshot,
            responsiblePersonId: command.responsiblePersonId,
            responsiblePersonSnapshot: command.responsiblePersonSnapshot,
            startMinuteOfDay: command.startMinuteOfDay,
            endMinuteOfDay: command.endMinuteOfDay,
            timeRangeLabelSnapshot: command.timeRangeLabelSnapshot,
            previousImosBalanceYen: command.previousImosBalanceYen,
            currentImosBalanceYen: command.currentImosBalanceYen,
            newageYen: command.newageYen,
            cashTotalYen: command.cashTotalYen,
            expenseYen: command.expenseYen,
            expenseReason: command.expenseReason,
            staffMealCashYen: command.staffMealCashYen,
            staffMealAlipayYen: command.staffMealAlipayYen,
            attachmentKeys: command.attachmentKeys,
          });
    const error = caughtError(await promise.catch((caught) => caught));

    expect(error.code).toBe('DATA_OPERATION_FAILED');
    expect(error.cause).toBe(errors);
  });

  it.each([
    ['get', [{ errorType: 'UnauthorizedException', message: 'denied' }], 'DATA_UNAUTHORIZED'],
    ['update', [{ extensions: { code: 'ConflictException' }, message: 'version conflict' }], 'DATA_CONFLICT'],
    ['get', [{ name: 'NotFoundException', message: 'missing' }], 'DATA_NOT_FOUND'],
    ['update', [{ message: 'generic conflict duplicate text' }], 'DATA_OPERATION_FAILED'],
  ])('maps structured %s failures to the expected stable code', async (operation, errors, expectedCode) => {
    const get = vi.fn().mockResolvedValue({ data: createdReport, errors: [] });
    const update = vi.fn().mockResolvedValue({ data: createdReport, errors: [] });
    (operation === 'get' ? get : update).mockResolvedValue({
      data: createdReport,
      errors,
    });
    const repository = loadedModule().createDailyReportsRepository({
      models: {
        DailyReport: {
          create: vi.fn(),
          get,
          update,
          dailyReportsByBusinessDate: vi.fn(),
        },
      },
    });
    const editable = updateCommand();

    const error = caughtError(
      await (operation === 'get'
        ? repository.getByReportKey('2026-08-24#shift-day')
        : repository.updateByReportKey(
            '2026-08-24#shift-day',
            editable,
          )
      ).catch((caught) => caught),
    );

    expect(error.code).toBe(expectedCode);
    expect(error.cause).toBe(errors);
  });

  it.each(['get', 'update'])('maps a thrown %s network failure to DATA_NETWORK_ERROR', async (operation) => {
    const cause = new TypeError('Failed to fetch');
    const get = vi.fn().mockRejectedValue(cause);
    const update = vi.fn().mockRejectedValue(cause);
    const repository = loadedModule().createDailyReportsRepository({
      models: {
        DailyReport: {
          create: vi.fn(),
          get,
          update,
          dailyReportsByBusinessDate: vi.fn(),
        },
      },
    });

    const error = caughtError(
      await (operation === 'get'
        ? repository.getByReportKey('2026-08-24#shift-day')
        : repository.updateByReportKey(
            '2026-08-24#shift-day',
            updateCommand(),
          )
      ).catch((caught) => caught),
    );

    expect(error.code).toBe('DATA_NETWORK_ERROR');
    expect(error.cause).toBe(cause);
  });

  it.each(['get', 'update'])('rejects a null %s Data result', async (operation) => {
    const get = vi.fn().mockResolvedValue({ data: createdReport, errors: [] });
    const update = vi.fn().mockResolvedValue({ data: createdReport, errors: [] });
    (operation === 'get' ? get : update).mockResolvedValue({
      data: null,
      errors: [],
    });
    const repository = loadedModule().createDailyReportsRepository({
      models: {
        DailyReport: {
          create: vi.fn(),
          get,
          update,
          dailyReportsByBusinessDate: vi.fn(),
        },
      },
    });
    const editable: UpdateDailyReportCommand = {
      shiftNameSnapshot: command.shiftNameSnapshot,
      responsiblePersonId: command.responsiblePersonId,
      responsiblePersonSnapshot: command.responsiblePersonSnapshot,
      startMinuteOfDay: command.startMinuteOfDay,
      endMinuteOfDay: command.endMinuteOfDay,
      timeRangeLabelSnapshot: command.timeRangeLabelSnapshot,
      previousImosBalanceYen: command.previousImosBalanceYen,
      currentImosBalanceYen: command.currentImosBalanceYen,
      newageYen: command.newageYen,
      cashTotalYen: command.cashTotalYen,
      expenseYen: command.expenseYen,
      expenseReason: command.expenseReason,
      staffMealCashYen: command.staffMealCashYen,
      staffMealAlipayYen: command.staffMealAlipayYen,
      attachmentKeys: command.attachmentKeys,
    };

    const result = await (operation === 'get'
      ? repository.getByReportKey('2026-08-24#shift-day')
      : repository.updateByReportKey('2026-08-24#shift-day', editable)
    ).catch((caught) => caught);
    const error = caughtError(result);

    expect(error.code).toBe(
      operation === 'get' ? 'DATA_NOT_FOUND' : 'DATA_OPERATION_FAILED',
    );
  });

  it('rejects an index page that contains Data errors even when data is present', async () => {
    const errors = [{ errorType: 'ResolverError', message: 'partial page' }];
    const repository = loadedModule().createDailyReportsRepository({
      models: {
        DailyReport: {
          create: vi.fn(),
          dailyReportsByBusinessDate: vi
            .fn()
            .mockResolvedValue({ data: [createdReport], errors }),
        },
      },
    });

    const error = caughtError(
      await repository.listByBusinessDate('2026-08-24').catch((caught) => caught),
    );

    expect(error.code).toBe('DATA_OPERATION_FAILED');
    expect(error.cause).toBe(errors);
  });

  it.each([
    ['null data', { data: null, nextToken: null, errors: [] }],
    ['non-array data', { data: { reportKey: 'bad' }, nextToken: null, errors: [] }],
  ])('rejects an index page with %s using DATA_PAGINATION_FAILED', async (_case, page) => {
    const repository = loadedModule().createDailyReportsRepository({
      models: {
        DailyReport: {
          create: vi.fn(),
          dailyReportsByBusinessDate: vi.fn().mockResolvedValue(page),
        },
      },
    });

    const error = caughtError(
      await repository.listByBusinessDate('2026-08-24').catch((caught) => caught),
    );

    expect(error.code).toBe('DATA_PAGINATION_FAILED');
  });

  it('rejects a repeated index nextToken using DATA_PAGINATION_FAILED', async () => {
    const dailyReportsByBusinessDate = vi
      .fn()
      .mockResolvedValueOnce({ data: [createdReport], nextToken: 'same', errors: [] })
      .mockResolvedValueOnce({ data: [createdReport], nextToken: 'same', errors: [] });
    const repository = loadedModule().createDailyReportsRepository({
      models: {
        DailyReport: { create: vi.fn(), dailyReportsByBusinessDate },
      },
    });

    const error = caughtError(
      await repository.listByBusinessDate('2026-08-24').catch((caught) => caught),
    );

    expect(error.code).toBe('DATA_PAGINATION_FAILED');
    expect(dailyReportsByBusinessDate).toHaveBeenCalledTimes(2);
  });
});

function updateCommand(): UpdateDailyReportCommand {
  return {
    shiftNameSnapshot: command.shiftNameSnapshot,
    responsiblePersonId: command.responsiblePersonId,
    responsiblePersonSnapshot: command.responsiblePersonSnapshot,
    startMinuteOfDay: command.startMinuteOfDay,
    endMinuteOfDay: command.endMinuteOfDay,
    timeRangeLabelSnapshot: command.timeRangeLabelSnapshot,
    previousImosBalanceYen: command.previousImosBalanceYen,
    currentImosBalanceYen: command.currentImosBalanceYen,
    newageYen: command.newageYen,
    cashTotalYen: command.cashTotalYen,
    expenseYen: command.expenseYen,
    expenseReason: command.expenseReason,
    staffMealCashYen: command.staffMealCashYen,
    staffMealAlipayYen: command.staffMealAlipayYen,
    attachmentKeys: command.attachmentKeys,
  };
}

function createdReportInput(): Record<string, unknown> {
  return {
    reportKey: '2026-08-24#shift-day',
    businessDate: '2026-08-24',
    shiftId: 'shift-day',
    shiftNameSnapshot: '日班',
    responsiblePersonId: 'person-1',
    responsiblePersonSnapshot: '张三',
    startMinuteOfDay: 540,
    endMinuteOfDay: 1020,
    timeRangeLabelSnapshot: '09:00-17:00',
    previousImosBalanceYen: 100_000,
    currentImosBalanceYen: 120_000,
    newageYen: 8_000,
    cashTotalYen: 20_000,
    expenseYen: 500,
    expenseReason: '消耗品',
    staffMealCashYen: 1_200,
    staffMealAlipayYen: 800,
    attachmentKeys: ['submissions/sub-a/draft-1/att-1/票据.jpg'],
    submittedAt: '2026-08-24T10:11:12.000Z',
  };
}
