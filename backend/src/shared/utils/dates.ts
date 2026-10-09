/**
 * UTC date utilities for recurring generation (task 9.2).
 *
 * The recurring-generation rule (R13) decides, for each of the seven dates of a
 * target week, whether a given Task_Template should produce a Task. That
 * decision depends on the date's **weekday number**, and R13.6 requires the
 * weekday to be computed in **UTC** so the rule evaluation is independent of the
 * server's or client's local timezone — a template generated on a machine in
 * UTC-10 must match one generated in UTC+12.
 *
 * To stay timezone-independent, every helper here operates on the calendar date
 * string (`YYYY-MM-DD`) and constructs `Date` values at UTC midnight
 * (`T00:00:00Z`), reading only `getUTCDay()` / `getUTCDate()` — never the
 * local-time `getDay()` the original Base44 function used. The original ported
 * logic (`new Date(weekStart + 'T00:00:00')` + `getDay()`) was local-time
 * dependent; this module reproduces the same weekday numbering (0 = Sunday …
 * 6 = Saturday) deterministically in UTC.
 *
 * These helpers are pure and allocation-light so the generation service and its
 * property tests (tasks 9.4/9.6) can exercise them directly.
 */

/**
 * Strict `YYYY-MM-DD` shape: 4-digit year, 2-digit month, 2-digit day. This is
 * a structural gate only; {@link isValidIsoDate} additionally checks the date is
 * a real calendar date (rejecting e.g. `2024-02-30`).
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The number of days in a week — the span materialized by generation (R13.1). */
export const DAYS_IN_WEEK = 7;

/** Weekday number for Monday under the 0 = Sunday … 6 = Saturday scheme. */
export const MONDAY = 1;

/**
 * Report whether `value` is a valid ISO-8601 calendar date in `YYYY-MM-DD`
 * format (R13.9).
 *
 * Two checks: the string must match the strict `YYYY-MM-DD` shape, AND it must
 * round-trip through a UTC `Date` back to the same string. The round-trip is
 * what rejects well-shaped but non-existent dates such as `2024-02-30` or
 * `2024-13-01`, which `Date` would otherwise silently roll over into a
 * different day/month.
 *
 * @param value The candidate date string (e.g. from a request body).
 * @returns `true` when `value` is a real calendar date in `YYYY-MM-DD` form.
 */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  // Reject rollovers: a valid string reproduces itself from the parsed date.
  return toIsoDate(date) === value;
}

/**
 * Return the UTC weekday number for a `YYYY-MM-DD` date, where 0 = Sunday …
 * 6 = Saturday (R13.5, R13.6).
 *
 * Computed from `getUTCDay()` on a `Date` anchored at UTC midnight, so the
 * result never shifts with the host timezone. The caller is expected to pass a
 * date that already passed {@link isValidIsoDate}; a malformed input yields
 * `NaN` (from an invalid `Date`), which no recurrence rule matches.
 *
 * @param isoDate A valid `YYYY-MM-DD` calendar date.
 * @returns The UTC weekday number 0..6 (`NaN` for an unparseable input).
 */
export function utcWeekday(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

/**
 * Report whether `value` is a valid ISO `YYYY-MM-DD` date that falls on a
 * Monday in UTC (R13.9).
 *
 * This is the combined gate the generate endpoint applies to `weekStart`:
 * missing/malformed/non-Monday all fail here, so the service can reject before
 * creating any Task.
 *
 * @param value The candidate `weekStart` string.
 * @returns `true` only when `value` is a real `YYYY-MM-DD` date on a Monday.
 */
export function isUtcMonday(value: string): boolean {
  return isValidIsoDate(value) && utcWeekday(value) === MONDAY;
}

/**
 * Format a `Date` as a `YYYY-MM-DD` string using its UTC calendar components.
 *
 * Uses `toISOString().slice(0, 10)` so the date is read in UTC regardless of
 * the host timezone — matching how {@link weekDates} advances day-by-day.
 *
 * @param date The date to format.
 * @returns The UTC calendar date as `YYYY-MM-DD`.
 */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Return the seven `YYYY-MM-DD` dates of the week beginning at `weekStart`
 * (R13.1), computed in UTC.
 *
 * `weekStart` is expected to be a Monday (validated upstream by
 * {@link isUtcMonday}); the result is `[weekStart, +1d, …, +6d]` in order. Days
 * are advanced with `setUTCDate` so the sequence is immune to local DST shifts
 * — each entry is exactly 24h after the previous in UTC.
 *
 * @param weekStart A valid `YYYY-MM-DD` Monday (the week's first date).
 * @returns The seven ISO date strings of that week, Monday-first.
 */
export function weekDates(weekStart: string): string[] {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const dates: string[] = [];
  for (let i = 0; i < DAYS_IN_WEEK; i += 1) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + i);
    dates.push(toIsoDate(day));
  }
  return dates;
}

/**
 * Return the current calendar date as a `YYYY-MM-DD` string in UTC (task 11.1).
 *
 * Used by the dashboard aggregate (R16.1) to select "today's" tasks — the tasks
 * whose stored `due_date` equals the current UTC day. Computed from
 * {@link toIsoDate} so the "today" boundary is timezone-independent and matches
 * the UTC date math used everywhere else in this module (a task due on
 * `2024-06-01` is "today" for every caller regardless of host timezone).
 *
 * @param now The reference instant (defaults to `new Date()`); injectable so
 *   tests can pin "today" and assert the dashboard selection deterministically.
 * @returns The current UTC calendar date as `YYYY-MM-DD`.
 */
export function todayIsoDate(now: Date = new Date()): string {
  return toIsoDate(now);
}

/* ------------------------------------------------------------------------- *
 * Leaderboard period boundaries (task 10.1)                                  *
 * ------------------------------------------------------------------------- */

/**
 * The leaderboard aggregation windows accepted by `GET /family/leaderboard`.
 * Kept as a local union so {@link periodStart} is total over its input; the
 * route's Zod schema (`z.enum(LEADERBOARD_PERIOD_VALUES)`) is the gate that
 * rejects anything outside this set as `422` before the service runs (R15.5).
 */
export type LeaderboardPeriodName = 'today' | 'week' | 'month' | 'all';

/**
 * Compute the inclusive **UTC** lower bound on `created_at` for a leaderboard
 * period, or `null` when the period includes every ledger row (R15.1/R15.4).
 *
 * This is a UTC port of the frontend `familyUtils.periodStart`, which anchors on
 * *today at local midnight* and subtracts a window; here the anchor is **UTC
 * midnight of the current day** so the boundary is timezone-independent and
 * matches the UTC date math used elsewhere in this module. Starting from that
 * UTC start-of-day:
 *
 *   - `today` → start of the current UTC day (00:00:00Z) — only rows from today.
 *   - `week`  → six days earlier (a rolling 7-day window, inclusive of today),
 *               mirroring the frontend's `setDate(getDate() - 6)`.
 *   - `month` → one calendar month earlier, mirroring `setMonth(getMonth()-1)`.
 *   - `all`   → `null`: no lower bound, every row is included (R15.4). The
 *               frontend approximates this with a 20-year lookback; returning
 *               `null` is the exact, boundary-free equivalent the repository
 *               turns into "no `created_at` filter".
 *
 * The returned bound is a full ISO-8601 instant at UTC midnight
 * (`YYYY-MM-DDT00:00:00.000Z`) so it compares correctly against the
 * `timestamptz` `created_at` column.
 *
 * @param period The validated period name.
 * @param now    The reference instant (defaults to `new Date()`); injectable so
 *   tests can pin "now" and assert the boundary deterministically.
 * @returns The inclusive UTC start instant, or `null` for `all`.
 */
export function periodStart(
  period: LeaderboardPeriodName,
  now: Date = new Date(),
): string | null {
  if (period === 'all') {
    return null;
  }

  // Anchor at UTC midnight of the current day (00:00:00.000Z).
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  if (period === 'week') {
    start.setUTCDate(start.getUTCDate() - 6);
  } else if (period === 'month') {
    start.setUTCMonth(start.getUTCMonth() - 1);
  }
  // 'today' keeps the UTC start-of-day anchor unchanged.

  return start.toISOString();
}
