/**
 * String-literal union types derived from the shared enum tuples in
 * `shared/constants`. Keeping them here (rather than re-declaring the unions)
 * guarantees the types and the runtime arrays can never drift apart.
 */
import type {
  RELATIONSHIP_VALUES,
  MEMBER_TYPE_VALUES,
  TASK_STATUS_VALUES,
  PRIORITY_VALUES,
  RECURRENCE_TYPE_VALUES,
  TRANSACTION_TYPE_VALUES,
  LEADERBOARD_PERIOD_VALUES,
} from '../constants/index.js';

/** `responsible_users.relationship`. */
export type Relationship = (typeof RELATIONSHIP_VALUES)[number];

/** `family_members.member_type`. */
export type MemberType = (typeof MEMBER_TYPE_VALUES)[number];

/** `tasks.status`. */
export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

/** `tasks.priority` / `task_templates.priority`. */
export type Priority = (typeof PRIORITY_VALUES)[number];

/** `task_templates.recurrence_type`. */
export type RecurrenceType = (typeof RECURRENCE_TYPE_VALUES)[number];

/** `points_transactions.transaction_type`. */
export type TransactionType = (typeof TRANSACTION_TYPE_VALUES)[number];

/** `GET /family/leaderboard?period=`. */
export type LeaderboardPeriod = (typeof LEADERBOARD_PERIOD_VALUES)[number];
