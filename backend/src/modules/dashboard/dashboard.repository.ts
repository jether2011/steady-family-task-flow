/**
 * Dashboard & board repository — the ONLY layer in this module that talks to
 * Supabase. Backs the aggregate home view + weekly board (task 11.1):
 *   - {@link loadFamilyAndResponsible} reads the household row + its owning
 *     responsible-user row so the service can compose the single frontend
 *     "family" DTO on the dashboard (R16.1), reusing the family module's read.
 *   - {@link listActiveMembers} reads the family's ACTIVE roster (R16.1).
 *   - {@link listTasksByDueDate} reads the family's tasks for a single
 *     `due_date` — the dashboard's "today's tasks" (R16.1).
 *   - {@link listTasksByWeekStart} reads the family's tasks for one
 *     `week_start` — the board's week slice (R17.1).
 *   - {@link listAllPoints} reads every ledger row of the family so the service
 *     can sum per-member totals (R16.3; the ledger is the source of truth).
 *
 * ### Which Supabase client
 *
 * Every operation uses the **service-role client**, matching every other module
 * and the context resolver. All queries are keyed strictly by the
 * session-derived `familyId`, so no cross-family row is reachable even though
 * RLS is bypassed (R16.2, R17.3). The family + active-roster reads reuse the
 * family and gamification repositories rather than duplicating their SQL.
 */
import type {
  PointsTransactionRow,
  TaskRow,
} from '../../shared/types/index.js';
import { getServiceRoleClient } from '../../config/supabase.js';
import {
  loadFamilyAndResponsible,
  type FamilyAndResponsible,
} from '../family/family.repository.js';
import { listActiveMembers } from '../gamification/gamification.repository.js';

// Re-export the reused family + active-member reads so the service imports its
// whole data surface from this one module boundary.
export { loadFamilyAndResponsible, listActiveMembers };
export type { FamilyAndResponsible };

/** Columns selected for a task row (mirrors the tasks module selection). */
const TASK_COLUMNS =
  'id, family_id, template_id, title, description, assigned_member_id, ' +
  'created_by_user_id, status, priority, points, due_date, due_time, ' +
  'week_start, carried_from_task_id, created_at, updated_at';

/** Columns selected for a points-ledger row. */
const POINTS_COLUMNS =
  'id, family_id, member_id, task_id, points, transaction_type, created_at';

/**
 * List the family's tasks whose `due_date` equals `dueDate` — the dashboard's
 * "today's tasks" (R16.1). Always keyed by `family_id` first, so the result is
 * strictly family-scoped (R16.2). Ordered by `created_at` for a stable listing.
 *
 * @param familyId Session-derived `families.id`.
 * @param dueDate  The `YYYY-MM-DD` day to select (today in UTC).
 */
export async function listTasksByDueDate(
  familyId: string,
  dueDate: string,
): Promise<TaskRow[]> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('tasks')
    .select(TASK_COLUMNS)
    .eq('family_id', familyId)
    .eq('due_date', dueDate)
    .order('created_at', { ascending: true })
    .returns<TaskRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

/**
 * List the family's tasks whose `week_start` equals `weekStart` — the board's
 * week slice (R17.1). Always keyed by `family_id` first, so the result is
 * strictly family-scoped (R17.3). Ordered by `created_at` for a stable listing.
 *
 * @param familyId  Session-derived `families.id`.
 * @param weekStart The `YYYY-MM-DD` week-start to select.
 */
export async function listTasksByWeekStart(
  familyId: string,
  weekStart: string,
): Promise<TaskRow[]> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('tasks')
    .select(TASK_COLUMNS)
    .eq('family_id', familyId)
    .eq('week_start', weekStart)
    .order('created_at', { ascending: true })
    .returns<TaskRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

/**
 * List EVERY ledger row of the family — the raw input the dashboard totals sum
 * over (R16.3; the Points_Ledger is the single source of truth). Keyed strictly
 * by `family_id` (R16.2); no member/date filter, as the service buckets by
 * `member_id` in memory.
 *
 * @param familyId Session-derived `families.id`.
 */
export async function listAllPoints(
  familyId: string,
): Promise<PointsTransactionRow[]> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('points_transactions')
    .select(POINTS_COLUMNS)
    .eq('family_id', familyId)
    .returns<PointsTransactionRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}
