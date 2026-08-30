import { DateTime } from 'luxon';

import { todayTokyo } from '@/utils/tokyo';

export const KITCHEN_BUSINESS_DATE_NOT_ALLOWED_MESSAGE =
  '未来の業務日は入力できません';

export function isKitchenBusinessDateAllowed(
  businessDate: string,
  currentBusinessDate = todayTokyo(),
): boolean {
  const parsed = DateTime.fromISO(businessDate, { zone: 'Asia/Tokyo' });
  return (
    parsed.isValid &&
    parsed.toISODate() === businessDate &&
    businessDate <= currentBusinessDate
  );
}

export function isKitchenDatePickerDisabled(
  date: Date,
  currentBusinessDate = todayTokyo(),
): boolean {
  const businessDate = DateTime.fromObject(
    {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
    },
    { zone: 'Asia/Tokyo' },
  ).toISODate();
  return (
    businessDate === null ||
    !isKitchenBusinessDateAllowed(businessDate, currentBusinessDate)
  );
}
