import { MAX_YEN } from '@fsk/domain';

import { getDataClient, type FskDataClient } from './client';
import {
  DataRepositoryError,
  classifyDataFailure,
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
): Promise<T> {
  try {
    const result = await load();
    if (hasDataErrors(result.errors)) {
      throw classifyDataFailure(result.errors);
    }
    if (result.data === null) throw dataOperationFailed();
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
    async getContext() {
      return dataResult(() => resolveClient().queries.getKitchenContext());
    },
  };
}

export function createOwnerMasterDataRepository(
  client?: FskDataClient,
) {
  const resolveClient = () => client ?? getDataClient();
  return {
    async createShift(value: ShiftDefinitionInput) {
      assertShift(value);
      return dataResult(() =>
        resolveClient().models.ShiftDefinition.create(value),
      );
    },
    async updateShift(value: ShiftDefinitionInput) {
      assertShift(value);
      return dataResult(() =>
        resolveClient().models.ShiftDefinition.update(value),
      );
    },
    async deleteShift(id: string) {
      return dataResult(() =>
        resolveClient().models.ShiftDefinition.delete({ id }),
      );
    },
    async listShifts() {
      return listAll((options) =>
        resolveClient().models.ShiftDefinition.list(options),
      );
    },
    async createResponsiblePerson(value: ResponsiblePersonInput) {
      assertPerson(value);
      return dataResult(() =>
        resolveClient().models.ResponsiblePerson.create(value),
      );
    },
    async updateResponsiblePerson(value: ResponsiblePersonInput) {
      assertPerson(value);
      return dataResult(() =>
        resolveClient().models.ResponsiblePerson.update(value),
      );
    },
    async deleteResponsiblePerson(id: string) {
      return dataResult(() =>
        resolveClient().models.ResponsiblePerson.delete({ id }),
      );
    },
    async listResponsiblePersons() {
      return listAll((options) =>
        resolveClient().models.ResponsiblePerson.list(options),
      );
    },
    async createSetting(value: AppSettingInput) {
      assertSetting(value);
      return dataResult(() => resolveClient().models.AppSetting.create(value));
    },
    async updateSetting(value: AppSettingInput) {
      assertSetting(value);
      return dataResult(() => resolveClient().models.AppSetting.update(value));
    },
    async deleteSetting(id: string) {
      return dataResult(() => resolveClient().models.AppSetting.delete({ id }));
    },
    async getSetting(id: string) {
      return dataResult(() => resolveClient().models.AppSetting.get({ id }));
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
