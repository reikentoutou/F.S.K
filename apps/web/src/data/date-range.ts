import { DateTime } from 'luxon';

const TOKYO_ZONE = 'Asia/Tokyo';
const MAX_BUSINESS_DATES = 366;

function parseBusinessDate(value: string): DateTime {
  const parsed = DateTime.fromISO(value, { zone: TOKYO_ZONE });
  if (!parsed.isValid || parsed.toISODate() !== value) {
    throw new Error('BUSINESS_DATE_INVALID');
  }
  return parsed.startOf('day');
}

export function businessDateRange(from: string, to: string): string[] {
  const start = parseBusinessDate(from);
  const end = parseBusinessDate(to);
  const dayCount = Math.round(end.diff(start, 'days').days) + 1;
  if (dayCount < 1) throw new Error('BUSINESS_DATE_RANGE_REVERSED');
  if (dayCount > MAX_BUSINESS_DATES) {
    throw new Error('BUSINESS_DATE_RANGE_TOO_LARGE');
  }
  return Array.from({ length: dayCount }, (_, index) =>
    start.plus({ days: index }).toISODate()!,
  );
}

export function recentTokyoBusinessDateRange(
  days: number,
  now = new Date(),
): string[] {
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new Error('BUSINESS_DATE_RANGE_INVALID');
  }
  if (days > MAX_BUSINESS_DATES) {
    throw new Error('BUSINESS_DATE_RANGE_TOO_LARGE');
  }
  const end = DateTime.fromJSDate(now).setZone(TOKYO_ZONE).startOf('day');
  return businessDateRange(
    end.minus({ days: days - 1 }).toISODate()!,
    end.toISODate()!,
  );
}
