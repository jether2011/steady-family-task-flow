/**
 * Shared enum value arrays and leaderboard periods.
 *
 * Enums in the database are `TEXT ... CHECK (...)` constraints (migration
 * `001_initial_schema.sql`), so the single source of truth for the allowed
 * values lives here as `as const` tuples. These are consumed by:
 *   - the DB row / DTO string-literal union types in `shared/types`
 *   - Zod schemas (`z.enum(RELATIONSHIP_VALUES)`) in later tasks
 *   - services that need to validate or branch on an enum value
 *
 * Every tuple is frozen via `as const` so callers get precise literal types
 * and cannot mutate the shared arrays.
 */

/** `responsible_users.relationship` CHECK values (R2.x). */
export const RELATIONSHIP_VALUES = ['FATHER', 'MOTHER', 'GUARDIAN', 'OTHER'] as const;

/** `family_members.member_type` CHECK values. */
export const MEMBER_TYPE_VALUES = ['PARENT', 'CHILD', 'DEPENDENT'] as const;

/** `tasks.status` CHECK values (board columns). */
export const TASK_STATUS_VALUES = ['BACKLOG', 'TODO', 'WORKING', 'DONE'] as const;

/** `tasks.priority` / `task_templates.priority` CHECK values. */
export const PRIORITY_VALUES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

/** `task_templates.recurrence_type` CHECK values. */
export const RECURRENCE_TYPE_VALUES = ['DAILY', 'WEEKDAYS', 'WEEKLY', 'CUSTOM'] as const;

/**
 * `points_transactions.transaction_type` CHECK values. Includes `REDEMPTION`
 * (R18.12) alongside the ledger movements written by completion/reopen.
 */
export const TRANSACTION_TYPE_VALUES = [
  'TASK_COMPLETION',
  'MANUAL_ADJUSTMENT',
  'REVERSAL',
  'REDEMPTION',
] as const;

/** Leaderboard aggregation windows for `GET /family/leaderboard?period=`. */
export const LEADERBOARD_PERIOD_VALUES = ['today', 'week', 'month', 'all'] as const;

/**
 * Named `tasks.status` values for services that branch on specific columns
 * without re-indexing into {@link TASK_STATUS_VALUES}.
 */
export const STATUS = {
  BACKLOG: 'BACKLOG',
  TODO: 'TODO',
  WORKING: 'WORKING',
  DONE: 'DONE',
} as const;
