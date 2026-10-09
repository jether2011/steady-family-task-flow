/**
 * Property 14 (task 9.6): invalid recurrence and `weekStart` inputs are rejected
 * at the schema boundary, which is precisely what produces the `422 VALIDATION`
 * with no side effects — the Zod schemas run before the generate/template
 * services, so a rejected body never reaches the DB and never creates a Task
 * (R13.9) or Task_Template (R12.5).
 *
 * This is a SCHEMA-level property test: it exercises the Zod contracts
 * (`Generate`, `TemplateCreate`) directly with `fast-check`, so no database is
 * needed. "No side effects" is established structurally — validation failing
 * before any handler runs is the mechanism by which the system creates nothing.
 *
 * - Part A (R13.9): `Generate.safeParse({ weekStart })` fails for any string
 *   that is not a valid ISO `YYYY-MM-DD` date on a Monday (malformed strings,
 *   valid non-Monday dates, empty, rollovers like `2024-02-30`), and succeeds
 *   for a valid UTC Monday.
 * - Part B (R12.5): `TemplateCreate.safeParse(...)` fails for a CUSTOM body
 *   whose `recurrence_config.days` is missing, empty, or carries an
 *   out-of-range/non-integer weekday; succeeds for CUSTOM with a non-empty
 *   array of ints in 0..6; and succeeds for any non-CUSTOM `recurrence_type`
 *   regardless of `days`.
 */
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RECURRENCE_TYPE_VALUES } from '../../src/shared/constants/index.js';
import { Generate, TemplateCreate } from '../../src/modules/templates/template.schemas.js';
import { isUtcMonday, isValidIsoDate, utcWeekday } from '../../src/shared/utils/dates.js';

const NUM_RUNS = 200;

// Pin a deliberately non-UTC timezone so the Monday check stays UTC-anchored:
// a local-time implementation would shift the weekday and let the properties
// catch it.
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles';
});
afterAll(() => {
  process.env.TZ = originalTz;
});

/**
 * A real `YYYY-MM-DD` calendar date derived from an epoch-day offset, so every
 * generated value is a valid date (no rollovers). The span covers several years
 * on both sides of 2024 to exercise many weekdays, months, and leap years.
 */
const isoDate: fc.Arbitrary<string> = fc
  .integer({ min: -3650, max: 3650 })
  .map((offsetDays) => {
    const d = new Date(Date.UTC(2024, 0, 1));
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  });

/** A valid ISO date that is a Monday in UTC. */
const mondayIso: fc.Arbitrary<string> = isoDate.filter((s) => utcWeekday(s) === 1);

/** A valid ISO date that is NOT a Monday in UTC. */
const nonMondayIso: fc.Arbitrary<string> = isoDate.filter((s) => utcWeekday(s) !== 1);

/**
 * Strings that are not a valid ISO `YYYY-MM-DD` Monday: arbitrary junk,
 * well-known malformed shapes, empty, and rollover dates. Filtered through
 * {@link isUtcMonday} so a chance-valid Monday never slips into the "invalid"
 * bucket.
 */
const invalidWeekStart: fc.Arbitrary<string> = fc
  .oneof(
    fc.string(),
    fc.constantFrom(
      '',
      '2024-1-8',
      '2024/01/08',
      '08-01-2024',
      '2024-02-30',
      '2023-02-29',
      '2024-13-01',
      '2024-00-10',
      '2024-01-08T00:00:00Z',
      'not-a-date',
    ),
    nonMondayIso,
  )
  .filter((s) => !isUtcMonday(s));

const recurrenceTypes = fc.constantFrom(...RECURRENCE_TYPE_VALUES);
const nonCustomRecurrence = recurrenceTypes.filter((t) => t !== 'CUSTOM');

/** A non-empty array of valid weekday integers (0..6). */
const validDays: fc.Arbitrary<number[]> = fc.array(fc.integer({ min: 0, max: 6 }), {
  minLength: 1,
  maxLength: 7,
});

/**
 * A `days` array that violates the 0..6-integer rule: contains at least one
 * out-of-range or non-integer value.
 */
const invalidDays: fc.Arbitrary<number[]> = fc
  .array(
    fc.oneof(
      fc.integer({ min: 0, max: 6 }), // valid filler
      fc.integer({ min: 7, max: 100 }), // too large
      fc.integer({ min: -100, max: -1 }), // negative
      fc.double({ min: 0, max: 6, noInteger: true, noNaN: true }), // non-integer
    ),
    { minLength: 1, maxLength: 6 },
  )
  .filter((arr) => arr.some((n) => !Number.isInteger(n) || n < 0 || n > 6));

describe('Feature: family-task-board-backend, Property 14: Invalid recurrence and weekStart inputs are rejected with no side effects', () => {
  // --- Part A: Generate.weekStart (R13.9) --------------------------------- //

  it('rejects every weekStart that is not a valid ISO YYYY-MM-DD Monday (R13.9)', () => {
    fc.assert(
      fc.property(invalidWeekStart, (weekStart) => {
        expect(Generate.safeParse({ weekStart }).success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects non-string / missing weekStart (R13.9)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          fc.constant(null),
          fc.integer(),
          fc.boolean(),
          fc.object(),
        ),
        (weekStart) => {
          expect(Generate.safeParse({ weekStart }).success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('accepts a valid ISO weekStart that falls on a Monday (R13.9)', () => {
    fc.assert(
      fc.property(mondayIso, (weekStart) => {
        // Precondition sanity: the generated value really is a valid Monday.
        expect(isValidIsoDate(weekStart)).toBe(true);
        expect(Generate.safeParse({ weekStart }).success).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects any extra key on the generate body (strict)', () => {
    fc.assert(
      fc.property(mondayIso, fc.string(), (weekStart, extraValue) => {
        const result = Generate.safeParse({ weekStart, unexpected: extraValue });
        expect(result.success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // --- Part B: TemplateCreate CUSTOM days rule (R12.5) -------------------- //

  it('rejects a CUSTOM template whose days array is missing or empty (R12.5)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.oneof(fc.constant(undefined), fc.constant<number[]>([])),
        (title, days) => {
          const body =
            days === undefined
              ? { title, recurrence_type: 'CUSTOM' as const }
              : { title, recurrence_type: 'CUSTOM' as const, recurrence_config: { days } };
          expect(TemplateCreate.safeParse(body).success).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects a CUSTOM template whose days contain an out-of-range or non-integer value (R12.5)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), invalidDays, (title, days) => {
        const body = {
          title,
          recurrence_type: 'CUSTOM' as const,
          recurrence_config: { days },
        };
        expect(TemplateCreate.safeParse(body).success).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('accepts a CUSTOM template with a non-empty days array of ints in 0..6 (R12.5)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), validDays, (title, days) => {
        const body = {
          title,
          recurrence_type: 'CUSTOM' as const,
          recurrence_config: { days },
        };
        expect(TemplateCreate.safeParse(body).success).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('accepts a non-CUSTOM template regardless of days (R12.5)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        nonCustomRecurrence,
        // days may be absent, empty, or populated — none of it matters for non-CUSTOM.
        fc.oneof(
          fc.constant(undefined),
          fc.constant<number[]>([]),
          validDays,
        ),
        (title, recurrence_type, days) => {
          const body =
            days === undefined
              ? { title, recurrence_type }
              : { title, recurrence_type, recurrence_config: { days } };
          expect(TemplateCreate.safeParse(body).success).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
