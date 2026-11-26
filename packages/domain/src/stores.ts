import { dailyReportKey } from './daily-report.js';

export const STORES = [
  { id: '02', name: '2 店' },
  { id: '03', name: '3 店' },
] as const;
export type StoreId = typeof STORES[number]['id'];
export type StoreScope = StoreId | 'all';

export function assertStoreId(value: unknown): asserts value is StoreId {
  if (value !== '02' && value !== '03') throw new Error('STORE_FORBIDDEN');
}

export function resolveStoreAccess(claims: Record<string, unknown>, requested?: string | null): StoreId {
  const groups = claims['cognito:groups'];
  if (!Array.isArray(groups) || groups.length !== 1) throw new Error('STORE_FORBIDDEN');
  if (groups[0] === 'OWNER') {
    assertStoreId(requested);
    return requested;
  }
  const username = claims['cognito:username'] ?? claims.username;
  const store = username === 'store02' ? '02' : username === 'store03' ? '03' : null;
  if (groups[0] !== 'KITCHEN' || !store || (requested != null && requested !== store)) {
    throw new Error('STORE_FORBIDDEN');
  }
  return store;
}

export function storeResourceId(storeId: StoreId, id: string): string {
  assertStoreId(storeId);
  if (!id || id.includes('#')) throw new Error('INVALID_STORE_RESOURCE');
  if (/^\d\d_/.test(id)) {
    if (!id.startsWith(`${storeId}_`)) throw new Error('STORE_FORBIDDEN');
    return id;
  }
  return `${storeId}_${id}`;
}

export function storeReportKey(storeId: StoreId, date: string, shiftId: string): string {
  return `${storeId}#${dailyReportKey(date, storeResourceId(storeId, shiftId))}`;
}

export function storeLabel(storeId?: string | null): string {
  return STORES.find((store) => store.id === storeId)?.name ?? '';
}
