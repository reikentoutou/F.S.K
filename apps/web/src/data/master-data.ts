import { MAX_YEN, storeResourceId, type StoreScope } from '@fsk/domain';

import { getDataClient, type FskDataClient } from './client';
import {
  DataRepositoryError,
  classifyDataFailure,
  dataNotFound,
  dataOperationFailed,
  dataPaginationFailed,
  hasDataErrors,
} from './errors';

export interface ShiftDefinitionInput {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface ResponsiblePersonInput {
  id: string;
  name: string;
  active: boolean;
}

export interface AppSettingInput {
  id: string;
  registerFloatAmount: number;
  setupCompleted: boolean;
}

function invalidMasterData(): never {
  throw new DataRepositoryError('INVALID_MASTER_DATA');
}

function assertActive(value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') invalidMasterData();
}

function assertShift(value: ShiftDefinitionInput): void {
  assertActive(value.active);
  if (!Number.isSafeInteger(value.sortOrder)) invalidMasterData();
}

function assertPerson(value: ResponsiblePersonInput): void {
  assertActive(value.active);
}

function assertSetting(value: AppSettingInput): void {
  assertActive(value.setupCompleted);
  if (
    !Number.isSafeInteger(value.registerFloatAmount) ||
    value.registerFloatAmount < 0 ||
    value.registerFloatAmount > MAX_YEN
  ) {
    invalidMasterData();
  }
}

async function dataResult<T>(
  load: () => Promise<{ data: T | null; errors?: readonly unknown[] }>,
  nullResult: 'NOT_FOUND' | 'OPERATION_FAILED' = 'OPERATION_FAILED',
): Promise<T> {
  try {
    const result = await load();
    if (hasDataErrors(result.errors)) {
      throw classifyDataFailure(result.errors);
    }
    if (result.data === null) {
      throw nullResult === 'NOT_FOUND' ? dataNotFound() : dataOperationFailed();
    }
    return result.data;
  } catch (cause) {
    if (cause instanceof DataRepositoryError) throw cause;
    throw classifyDataFailure(cause);
  }
}

export function createKitchenContextRepository(
  client?: FskDataClient,
) {
  const resolveClient = () => client ?? getDataClient();
  return {
    async getContext(businessDate: string) {
      return dataResult(() =>
        resolveClient().queries.getKitchenContext({ businessDate }),
      );
    },
  };
}

export function createOwnerMasterDataRepository(
  client?: FskDataClient,
  scope: StoreScope = '02',
) {
  const resolveClient = () => client ?? getDataClient();
  const store = () => {
    if (scope === 'all') throw new Error('STORE_REQUIRED');
    return scope;
  };
  const scoped = <T extends { id: string }>(value: T) => ({ ...value, id: storeResourceId(store(), value.id), storeId: store() });
  const listScope = <T extends { storeId?: string | null } | null>(values: T[]) => values.filter((value) => value && (scope === 'all' || value.storeId === scope));
  return {
    async createShift(value: ShiftDefinitionInput) {
      store();
      assertShift(value);
      return dataResult(() =>
        resolveClient().models.ShiftDefinition.create(scoped(value)),
      );
    },
    async updateShift(value: ShiftDefinitionInput) {
      store();
      assertShift(value);
      return dataResult(() =>
        resolveClient().models.ShiftDefinition.update(scoped(value)),
      );
    },
    async deleteShift(id: string) {
      store();
      return dataResult(() =>
        resolveClient().models.ShiftDefinition.delete({ id: storeResourceId(store(), id) }),
      );
    },
    async listShifts() {
      return listAll((options) =>
        resolveClient().models.ShiftDefinition.list({ ...options, ...(scope === 'all' ? {} : { filter: { storeId: { eq: scope } } }) }),
      ).then(listScope);
    },
    async createResponsiblePerson(value: ResponsiblePersonInput) {
      store();
      assertPerson(value);
      return dataResult(() =>
        resolveClient().models.ResponsiblePerson.create(scoped(value)),
      );
    },
    async updateResponsiblePerson(value: ResponsiblePersonInput) {
      store();
      assertPerson(value);
      return dataResult(() =>
        resolveClient().models.ResponsiblePerson.update(scoped(value)),
      );
    },
    async deleteResponsiblePerson(id: string) {
      store();
      return dataResult(() =>
        resolveClient().models.ResponsiblePerson.delete({ id: storeResourceId(store(), id) }),
      );
    },
    async listResponsiblePersons() {
      return listAll((options) =>
        resolveClient().models.ResponsiblePerson.list({ ...options, ...(scope === 'all' ? {} : { filter: { storeId: { eq: scope } } }) }),
      ).then(listScope);
    },
    async createSetting(value: AppSettingInput) {
      store();
      assertSetting(value);
      return dataResult(() => resolveClient().models.AppSetting.create(scoped(value)));
    },
    async updateSetting(value: AppSettingInput) {
      store();
      assertSetting(value);
      return dataResult(() => resolveClient().models.AppSetting.update(scoped(value)));
    },
    async deleteSetting(id: string) {
      store();
      return dataResult(() => resolveClient().models.AppSetting.delete({ id: storeResourceId(store(), id) }));
    },
    async getSetting(id: string) {
      if (scope === 'all') return { id: 'all', storeId: 'all', registerFloatAmount: 0, setupCompleted: true };
      return dataResult(
        () => resolveClient().models.AppSetting.get({ id: storeResourceId(store(), id) }),
        'NOT_FOUND',
      );
    },
  };
}

interface ListPage<T> {
  data: T[] | null;
  nextToken?: string | null;
  errors?: readonly unknown[];
}

async function listAll<T>(
  load: (options?: { nextToken?: string | null }) => Promise<ListPage<T>>,
): Promise<T[]> {
  const values: T[] = [];
  let nextToken: string | null | undefined;
  const observedTokens = new Set<string>();
  do {
    let result: ListPage<T>;
    try {
      result = await load(nextToken ? { nextToken } : undefined);
    } catch (cause) {
      throw classifyDataFailure(cause);
    }
    if (hasDataErrors(result.errors)) {
      throw classifyDataFailure(result.errors);
    }
    if (!Array.isArray(result.data)) {
      throw dataPaginationFailed(result.data);
    }
    values.push(...result.data);
    nextToken = result.nextToken;
    if (nextToken) {
      if (observedTokens.has(nextToken)) {
        throw dataPaginationFailed(new Error('REPEATED_DATA_NEXT_TOKEN'));
      }
      observedTokens.add(nextToken);
    }
  } while (nextToken);
  return values;
}

export const kitchenContextRepository = createKitchenContextRepository();
export const ownerMasterDataRepository = createOwnerMasterDataRepository();
