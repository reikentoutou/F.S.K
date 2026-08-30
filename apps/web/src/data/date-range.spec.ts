import { describe, expect, it } from 'vitest';

import {
  businessDateRange,
  recentTokyoBusinessDateRange,
} from './date-range';

describe('business date ranges', () => {
  it('returns every date in an inclusive Tokyo business-date interval', () => {
    expect(businessDateRange('2026-08-30', '2026-09-02')).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ]);
  });

  it('returns the latest 90 Tokyo business dates including today', () => {
    const beforeTokyoMidnight = recentTokyoBusinessDateRange(
      90,
      new Date('2026-08-24T14:59:59.000Z'),
    );
    expect(beforeTokyoMidnight).toHaveLength(90);
    expect(beforeTokyoMidnight.at(0)).toBe('2026-05-27');
    expect(beforeTokyoMidnight.at(-1)).toBe('2026-08-24');

    const afterTokyoMidnight = recentTokyoBusinessDateRange(
      90,
      new Date('2026-08-24T15:00:00.000Z'),
    );
    expect(afterTokyoMidnight).toHaveLength(90);
    expect(afterTokyoMidnight.at(0)).toBe('2026-05-28');
    expect(afterTokyoMidnight.at(-1)).toBe('2026-08-25');
  });

  it('accepts a 366-day inclusive interval', () => {
    const dates = businessDateRange('2025-01-01', '2026-01-01');

    expect(dates).toHaveLength(366);
    expect(dates.at(0)).toBe('2025-01-01');
    expect(dates.at(-1)).toBe('2026-01-01');
  });

  it('rejects an interval longer than 366 days before any repository reads', () => {
    expect(() => businessDateRange('2025-01-01', '2026-01-02')).toThrowError(
      'BUSINESS_DATE_RANGE_TOO_LARGE',
    );
  });

  it.each([
    ['invalid start', '2026-02-30', '2026-03-01', 'BUSINESS_DATE_INVALID'],
    ['reversed', '2026-08-25', '2026-08-24', 'BUSINESS_DATE_RANGE_REVERSED'],
  ])('rejects %s ranges', (_case, from, to, error) => {
    expect(() => businessDateRange(from, to)).toThrowError(error);
  });
});
