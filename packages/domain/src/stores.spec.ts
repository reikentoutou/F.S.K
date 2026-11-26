import { describe, expect, it } from 'vitest';
import { resolveStoreAccess, storeReportKey, storeResourceId } from './stores';

describe('store boundaries', () => {
  it('binds kitchen stores to authenticated usernames and rejects a forged store', () => {
    expect(resolveStoreAccess({ 'cognito:groups': ['KITCHEN'], 'cognito:username': 'store02' })).toBe('02');
    expect(resolveStoreAccess({ 'cognito:groups': ['KITCHEN'], 'cognito:username': 'store03' }, '03')).toBe('03');
    expect(() => resolveStoreAccess({ 'cognito:groups': ['KITCHEN'], 'cognito:username': 'store02' }, '03')).toThrow('STORE_FORBIDDEN');
    expect(() => resolveStoreAccess({ 'cognito:groups': ['KITCHEN'], 'cognito:username': 'kitchen' })).toThrow('STORE_FORBIDDEN');
    expect(() => resolveStoreAccess({}, '02')).toThrow('STORE_FORBIDDEN');
  });
  it('requires an explicit valid store for the owner', () => {
    expect(resolveStoreAccess({ 'cognito:groups': ['OWNER'] }, '03')).toBe('03');
    expect(() => resolveStoreAccess({ 'cognito:groups': ['OWNER'] })).toThrow();
    expect(() => resolveStoreAccess({ 'cognito:groups': ['OWNER'] }, '04')).toThrow();
  });
  it('separates equal business days and shifts across stores and refuses a mismatched resource', () => {
    expect(storeReportKey('02', '2026-11-26', '02_day')).not.toBe(storeReportKey('03', '2026-11-26', '03_day'));
    expect(storeResourceId('02', 'default')).toBe('02_default');
    expect(storeResourceId('02', '02_day')).toBe('02_day');
    expect(() => storeResourceId('02', '03_day')).toThrow('STORE_FORBIDDEN');
    expect(() => storeReportKey('02', '2026-11-26', '03_day')).toThrow('STORE_FORBIDDEN');
  });
});
