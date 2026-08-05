export const FIXED_SHIFT_NAMES = {
  webmasterMorning: '网管早班',
  day: '白班',
  night: '夜班',
  webmasterNight: '网管夜班',
} as const;

export type FixedShiftName =
  (typeof FIXED_SHIFT_NAMES)[keyof typeof FIXED_SHIFT_NAMES];

export const FIXED_SHIFTS = [
  { name: FIXED_SHIFT_NAMES.webmasterMorning, sortOrder: 1 },
  { name: FIXED_SHIFT_NAMES.day, sortOrder: 2 },
  { name: FIXED_SHIFT_NAMES.night, sortOrder: 3 },
  { name: FIXED_SHIFT_NAMES.webmasterNight, sortOrder: 4 },
] as const satisfies readonly {
  name: FixedShiftName;
  sortOrder: number;
}[];

export function previousShiftNameFor(
  shiftName: string,
): FixedShiftName | null {
  return shiftName === FIXED_SHIFT_NAMES.night
    ? FIXED_SHIFT_NAMES.day
    : null;
}
