import { describe, expect, it } from 'vitest';
import {
  FIXED_SHIFTS,
  FIXED_SHIFT_NAMES,
  previousShiftNameFor,
} from '../src/shifts/fixed-shifts';

describe('fixed shifts', () => {
  it('defines the four immutable shifts in display order', () => {
    expect(FIXED_SHIFTS).toEqual([
      { name: '网管早班', sortOrder: 1 },
      { name: '白班', sortOrder: 2 },
      { name: '夜班', sortOrder: 3 },
      { name: '网管夜班', sortOrder: 4 },
    ]);
  });

  it('only lets night shift inherit from day shift', () => {
    expect(previousShiftNameFor(FIXED_SHIFT_NAMES.night)).toBe(
      FIXED_SHIFT_NAMES.day,
    );
    expect(previousShiftNameFor(FIXED_SHIFT_NAMES.webmasterMorning)).toBeNull();
    expect(previousShiftNameFor(FIXED_SHIFT_NAMES.day)).toBeNull();
    expect(previousShiftNameFor(FIXED_SHIFT_NAMES.webmasterNight)).toBeNull();
    expect(previousShiftNameFor('临时班')).toBeNull();
  });
});
