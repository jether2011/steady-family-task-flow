/**
 * Unit tests for the UTC date utilities (task 9.2) that drive recurring
 * generation. These cover the weekday computation (R13.6), the week-date
 * expansion (R13.1), and the ISO/Monday validation gate used for `weekStart`
 * (R13.9). Timezone independence is asserted by pinning `process.env.TZ` to a
 * non-UTC zone for the duration of the suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DAYS_IN_WEEK,
  isUtcMonday,
  isValidIsoDate,
  toIsoDate,
  utcWeekday,
  weekDates,
} from '../../src/shared/utils/dates.js';

// Pin a deliberately non-UTC timezone so any accidental use of local-time
// Date methods (getDay/getDate) would shift results and fail these tests.
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles';
});
afterAll(() => {
  process.env.TZ = originalTz;
});

describe('isValidIsoDate', () => {
  it('accepts a real calendar date in YYYY-MM-DD form', () => {
    expect(isValidIsoDate('2024-01-01')).toBe(true);
    expect(isValidIsoDate('2024-02-29')).toBe(true); // leap year
  });

  it('rejects malformed shapes', () => {
    expect(isValidIsoDate('')).toBe(false);
    expect(isValidIsoDate('2024-1-1')).toBe(false);
    expect(isValidIsoDate('2024/01/01')).toBe(false);
    expect(isValidIsoDate('01-01-2024')).toBe(false);
    expect(isValidIsoDate('2024-01-01T00:00:00Z')).toBe(false);
  });

  it('rejects well-shaped but non-existent dates (rollover)', () => {
    expect(isValidIsoDate('2024-02-30')).toBe(false);
    expect(isValidIsoDate('2023-02-29')).toBe(false); // not a leap year
    expect(isValidIsoDate('2024-13-01')).toBe(false);
    expect(isValidIsoDate('2024-00-10')).toBe(false);
  });
});

describe('utcWeekday', () => {
  it('numbers days 0=Sunday .. 6=Saturday in UTC', () => {
    expect(utcWeekday('2024-01-07')).toBe(0); // Sunday
    expect(utcWeekday('2024-01-08')).toBe(1); // Monday
    expect(utcWeekday('2024-01-09')).toBe(2); // Tuesday
    expect(utcWeekday('2024-01-10')).toBe(3); // Wednesday
    expect(utcWeekday('2024-01-11')).toBe(4); // Thursday
    expect(utcWeekday('2024-01-12')).toBe(5); // Friday
    expect(utcWeekday('2024-01-13')).toBe(6); // Saturday
  });
});

describe('isUtcMonday', () => {
  it('is true only for a valid ISO date on a Monday', () => {
    expect(isUtcMonday('2024-01-08')).toBe(true); // Monday
  });

  it('is false for a valid non-Monday date', () => {
    expect(isUtcMonday('2024-01-09')).toBe(false); // Tuesday
    expect(isUtcMonday('2024-01-07')).toBe(false); // Sunday
  });

  it('is false for a missing/malformed/non-existent date', () => {
    expect(isUtcMonday('')).toBe(false);
    expect(isUtcMonday('2024-1-8')).toBe(false);
    expect(isUtcMonday('2024-02-30')).toBe(false);
  });
});

describe('weekDates', () => {
  it('returns the seven consecutive ISO dates starting at the Monday', () => {
    const dates = weekDates('2024-01-08');
    expect(dates).toHaveLength(DAYS_IN_WEEK);
    expect(dates).toEqual([
      '2024-01-08',
      '2024-01-09',
      '2024-01-10',
      '2024-01-11',
      '2024-01-12',
      '2024-01-13',
      '2024-01-14',
    ]);
  });

  it('crosses month and year boundaries correctly', () => {
    expect(weekDates('2024-12-30')).toEqual([
      '2024-12-30',
      '2024-12-31',
      '2025-01-01',
      '2025-01-02',
      '2025-01-03',
      '2025-01-04',
      '2025-01-05',
    ]);
  });

  it('is timezone-independent (first date equals the input Monday)', () => {
    // Under TZ=America/Los_Angeles a local-time implementation would roll the
    // first entry back a day; UTC math keeps it on the given Monday.
    expect(weekDates('2024-06-03')[0]).toBe('2024-06-03');
  });
});

describe('toIsoDate', () => {
  it('formats a Date to its UTC YYYY-MM-DD components', () => {
    expect(toIsoDate(new Date('2024-01-08T00:00:00Z'))).toBe('2024-01-08');
    // A time near midnight UTC must not roll into the previous local day.
    expect(toIsoDate(new Date('2024-01-08T00:30:00Z'))).toBe('2024-01-08');
  });
});
