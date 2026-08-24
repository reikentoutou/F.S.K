import { beforeAll, describe, expect, it, vi } from 'vitest';

interface MasterDataModule {
  createKitchenContextRepository(client: unknown): {
    getContext(): Promise<unknown>;
  };
  createOwnerMasterDataRepository(client: unknown): Record<
    string,
    (...args: never[]) => Promise<unknown>
  >;
}

interface RepositoryError extends Error {
  readonly code: string;
  readonly cause?: unknown;
}

let masterDataModule: MasterDataModule | undefined;
let moduleLoadError: unknown;

beforeAll(async () => {
  try {
    masterDataModule = (await import('./master-data')) as MasterDataModule;
  } catch (error) {
    moduleLoadError = error;
  }
});

function loadedModule(): MasterDataModule {
  expect(moduleLoadError).toBeUndefined();
  expect(masterDataModule).toBeDefined();
  return masterDataModule!;
}

function caughtError(value: unknown): RepositoryError {
  expect(value).toBeInstanceOf(Error);
  return value as RepositoryError;
}

function successfulModel() {
  const success = (data: unknown) => ({
    data,
    errors: [] as unknown[],
  });
  return {
    create: vi.fn(async (input: unknown) => success(input)),
    update: vi.fn(async (input: unknown) => success(input)),
    delete: vi.fn(async (input: unknown) => success(input)),
    get: vi.fn(async (input: unknown) => success(input)),
    list: vi.fn().mockResolvedValue({
      data: [] as unknown[],
      nextToken: null,
      errors: [] as unknown[],
    }),
  };
}

describe('master data repositories', () => {
  it('gives kitchen only the custom context query and no model or setting access', async () => {
    const context = {
      registerFloatAmount: 5_000,
      shifts: [{ id: 'day', name: '日班', sortOrder: 10 }],
      responsiblePersons: [{ id: 'p1', name: '张三' }],
    };
    const getKitchenContext = vi.fn().mockResolvedValue({ data: context, errors: [] });
    const forbiddenModelAccess = new Proxy(
      {},
      {
        get() {
          throw new Error('kitchen must not access model APIs');
        },
      },
    );
    const repository = loadedModule().createKitchenContextRepository({
      queries: { getKitchenContext },
      models: forbiddenModelAccess,
    });

    await expect(repository.getContext()).resolves.toEqual(context);
    expect(getKitchenContext).toHaveBeenCalledOnce();
    expect(getKitchenContext).toHaveBeenCalledWith();
    expect(Object.keys(repository)).toEqual(['getContext']);
  });

  it('rejects custom query errors even when the Function returned context data', async () => {
    const errors = [{ errorType: 'ResolverError', message: 'partial result' }];
    const repository = loadedModule().createKitchenContextRepository({
      queries: {
        getKitchenContext: vi.fn().mockResolvedValue({
          data: { registerFloatAmount: 5_000, shifts: [], responsiblePersons: [] },
          errors,
        }),
      },
    });

    const error = caughtError(await repository.getContext().catch((caught) => caught));

    expect(error.code).toBe('DATA_OPERATION_FAILED');
    expect(error.cause).toBe(errors);
  });

  it('uses model CRUD APIs for OWNER shifts, people and settings', async () => {
    const shift = successfulModel();
    const person = successfulModel();
    const setting = successfulModel();
    const repository = loadedModule().createOwnerMasterDataRepository({
      models: {
        ShiftDefinition: shift,
        ResponsiblePerson: person,
        AppSetting: setting,
      },
    });
    const shiftValue = { id: 'day', name: '日班', sortOrder: 10, active: true };
    const personValue = { id: 'p1', name: '张三', active: true };
    const settingValue = {
      id: 'default',
      registerFloatAmount: 5_000,
      setupCompleted: true,
    };

    await repository.createShift!(shiftValue as never);
    await repository.updateShift!(shiftValue as never);
    await repository.deleteShift!('day' as never);
    await repository.listShifts!();
    await repository.createResponsiblePerson!(personValue as never);
    await repository.updateResponsiblePerson!(personValue as never);
    await repository.deleteResponsiblePerson!('p1' as never);
    await repository.listResponsiblePersons!();
    await repository.createSetting!(settingValue as never);
    await repository.updateSetting!(settingValue as never);
    await repository.deleteSetting!('default' as never);
    await repository.getSetting!('default' as never);

    expect(shift.create).toHaveBeenCalledWith(shiftValue);
    expect(shift.update).toHaveBeenCalledWith(shiftValue);
    expect(shift.delete).toHaveBeenCalledWith({ id: 'day' });
    expect(shift.list).toHaveBeenCalledWith(undefined);
    expect(person.create).toHaveBeenCalledWith(personValue);
    expect(person.update).toHaveBeenCalledWith(personValue);
    expect(person.delete).toHaveBeenCalledWith({ id: 'p1' });
    expect(person.list).toHaveBeenCalledWith(undefined);
    expect(setting.create).toHaveBeenCalledWith(settingValue);
    expect(setting.update).toHaveBeenCalledWith(settingValue);
    expect(setting.delete).toHaveBeenCalledWith({ id: 'default' });
    expect(setting.get).toHaveBeenCalledWith({ id: 'default' });
  });

  it.each([
    ['shift active', 'createShift', { id: 'day', name: '日班', sortOrder: 10, active: 1 }],
    ['person active', 'createResponsiblePerson', { id: 'p1', name: '张三', active: 'yes' }],
    [
      'setting completion',
      'createSetting',
      { id: 'default', registerFloatAmount: 5_000, setupCompleted: 1 },
    ],
    [
      'negative register float',
      'createSetting',
      { id: 'default', registerFloatAmount: -1, setupCompleted: true },
    ],
    [
      'fractional register float',
      'updateSetting',
      { id: 'default', registerFloatAmount: 1.5, setupCompleted: true },
    ],
    [
      'register float above maximum',
      'updateSetting',
      { id: 'default', registerFloatAmount: 2_000_000_001, setupCompleted: true },
    ],
  ])('validates %s before calling a model operation', async (_case, method, input) => {
    const shift = successfulModel();
    const person = successfulModel();
    const setting = successfulModel();
    const repository = loadedModule().createOwnerMasterDataRepository({
      models: {
        ShiftDefinition: shift,
        ResponsiblePerson: person,
        AppSetting: setting,
      },
    });

    const error = caughtError(
      await repository[method]!(input as never).catch((caught) => caught),
    );

    expect(error.code).toBe('INVALID_MASTER_DATA');
    expect(shift.create).not.toHaveBeenCalled();
    expect(shift.update).not.toHaveBeenCalled();
    expect(person.create).not.toHaveBeenCalled();
    expect(person.update).not.toHaveBeenCalled();
    expect(setting.create).not.toHaveBeenCalled();
    expect(setting.update).not.toHaveBeenCalled();
  });

  it('rejects OWNER model errors even when Data includes a record', async () => {
    const errors = [{ errorType: 'ResolverError', message: 'operation failed' }];
    const shift = successfulModel();
    shift.create.mockResolvedValue({
      data: { id: 'day', name: '日班', sortOrder: 10, active: true },
      errors,
    });
    const repository = loadedModule().createOwnerMasterDataRepository({
      models: {
        ShiftDefinition: shift,
        ResponsiblePerson: successfulModel(),
        AppSetting: successfulModel(),
      },
    });

    const error = caughtError(
      await repository
        .createShift!({ id: 'day', name: '日班', sortOrder: 10, active: true } as never)
        .catch((caught) => caught),
    );

    expect(error.code).toBe('DATA_OPERATION_FAILED');
    expect(error.cause).toBe(errors);
  });

  it.each([
    ['null data', null],
    ['non-array data', { id: 'not-a-list' }],
  ])('rejects OWNER list %s using DATA_PAGINATION_FAILED', async (_case, data) => {
    const shift = successfulModel();
    shift.list.mockResolvedValue({ data, nextToken: null, errors: [] });
    const repository = loadedModule().createOwnerMasterDataRepository({
      models: {
        ShiftDefinition: shift,
        ResponsiblePerson: successfulModel(),
        AppSetting: successfulModel(),
      },
    });

    const error = caughtError(
      await repository.listShifts!().catch((caught) => caught),
    );

    expect(error.code).toBe('DATA_PAGINATION_FAILED');
  });

  it('rejects a repeated OWNER list nextToken using DATA_PAGINATION_FAILED', async () => {
    const shift = successfulModel();
    shift.list
      .mockResolvedValueOnce({ data: [], nextToken: 'same', errors: [] })
      .mockResolvedValueOnce({ data: [], nextToken: 'same', errors: [] });
    const repository = loadedModule().createOwnerMasterDataRepository({
      models: {
        ShiftDefinition: shift,
        ResponsiblePerson: successfulModel(),
        AppSetting: successfulModel(),
      },
    });

    const error = caughtError(
      await repository.listShifts!().catch((caught) => caught),
    );

    expect(error.code).toBe('DATA_PAGINATION_FAILED');
    expect(shift.list).toHaveBeenCalledTimes(2);
  });

  it('maps structured OWNER authorization errors without exposing SDK details to pages', async () => {
    const errors = [{ errorType: 'UnauthorizedException', message: 'denied' }];
    const setting = successfulModel();
    setting.get.mockResolvedValue({ data: null, errors });
    const repository = loadedModule().createOwnerMasterDataRepository({
      models: {
        ShiftDefinition: successfulModel(),
        ResponsiblePerson: successfulModel(),
        AppSetting: setting,
      },
    });

    const error = caughtError(
      await repository.getSetting!('default' as never).catch((caught) => caught),
    );

    expect(error.code).toBe('DATA_UNAUTHORIZED');
    expect(error.cause).toBe(errors);
  });

  it('maps thrown OWNER network failures to DATA_NETWORK_ERROR', async () => {
    const cause = new TypeError('Failed to fetch');
    const setting = successfulModel();
    setting.get.mockRejectedValue(cause);
    const repository = loadedModule().createOwnerMasterDataRepository({
      models: {
        ShiftDefinition: successfulModel(),
        ResponsiblePerson: successfulModel(),
        AppSetting: setting,
      },
    });

    const error = caughtError(
      await repository.getSetting!('default' as never).catch((caught) => caught),
    );

    expect(error.code).toBe('DATA_NETWORK_ERROR');
    expect(error.cause).toBe(cause);
  });

  it('maps an empty getSetting result to DATA_NOT_FOUND', async () => {
    const setting = successfulModel();
    setting.get.mockResolvedValue({ data: null, errors: [] });
    const repository = loadedModule().createOwnerMasterDataRepository({
      models: {
        ShiftDefinition: successfulModel(),
        ResponsiblePerson: successfulModel(),
        AppSetting: setting,
      },
    });

    const error = caughtError(
      await repository.getSetting!('default' as never).catch((caught) => caught),
    );

    expect(error.code).toBe('DATA_NOT_FOUND');
    expect(error.message).toBe('DATA_NOT_FOUND');
  });
});
