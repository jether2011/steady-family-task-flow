/**
 * Database row types — one interface per table in migration
 * `001_initial_schema.sql`. Field names are **snake_case** and match the
 * columns exactly; these describe what repositories read back from Supabase
 * before mapping to the camelCase-ish API DTOs in `dto.ts`.
 *
 * Conventions:
 *   - `uuid`/`text`/`timestamptz`/`date` columns are typed as `string`.
 *   - Nullable columns (no `NOT NULL`) are `T | null`.
 *   - `jsonb` is given a precise shape where the schema documents one
 *     (`recurrence_config.days`).
 */
import type {
  Relationship,
  MemberType,
  TaskStatus,
  Priority,
  RecurrenceType,
  TransactionType,
} from './enums.js';

/** `recurrence_config` jsonb payload (defaults to `{}`; `days` for CUSTOM). */
export interface RecurrenceConfig {
  days?: number[];
}

/** `responsible_users` — one row per authenticated adult. */
export interface ResponsibleUserRow {
  id: string;
  auth_user_id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  relationship: Relationship | null;
  created_at: string;
  updated_at: string;
}

/** `families` — household, 1:1 with a responsible user. */
export interface FamilyRow {
  id: string;
  responsible_user_id: string;
  name: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

/** `family_members`. */
export interface FamilyMemberRow {
  id: string;
  family_id: string;
  name: string;
  member_type: MemberType;
  avatar_url: string | null;
  color: string | null;
  birth_year: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** `task_templates`. */
export interface TaskTemplateRow {
  id: string;
  family_id: string;
  title: string;
  description: string | null;
  assigned_member_id: string | null;
  points: number;
  priority: Priority;
  recurrence_type: RecurrenceType;
  recurrence_config: RecurrenceConfig;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** `tasks`. */
export interface TaskRow {
  id: string;
  family_id: string;
  template_id: string | null;
  title: string;
  description: string | null;
  assigned_member_id: string | null;
  created_by_user_id: string;
  status: TaskStatus;
  priority: Priority;
  points: number;
  due_date: string | null;
  due_time: string | null;
  week_start: string | null;
  carried_from_task_id: string | null;
  created_at: string;
  updated_at: string;
}

/** `task_completions` — UNIQUE(task_id): at most one per task (R9.1). */
export interface TaskCompletionRow {
  id: string;
  task_id: string;
  family_id: string;
  completed_by_user_id: string;
  completed_by_member_id: string;
  completed_at: string;
}

/** `points_transactions` — the append-only points ledger. */
export interface PointsTransactionRow {
  id: string;
  family_id: string;
  member_id: string;
  task_id: string | null;
  points: number;
  transaction_type: TransactionType;
  created_at: string;
}

/** `awards`. */
export interface AwardRow {
  id: string;
  family_id: string;
  title: string;
  description: string | null;
  points_cost: number;
  icon: string;
  color: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}
