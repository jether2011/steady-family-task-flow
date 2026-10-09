/**
 * Task repository — the ONLY layer in this module that talks to Supabase.
 *
 * Backs the task CRUD slice (task 6.1):
 *   - {@link createTask} inserts a new task with `family_id` and
 *     `created_by_user_id` from the session; `status`/`priority` are left to
 *     the DB column defaults (TODO/MEDIUM) when not supplied (R4.1, R4.2).
 *   - {@link findTaskById} loads a single task for the ownership guard.
 *   - {@link updateTask} applies a partial update to a task (R4.3).
 *   - {@link deleteTask} hard-deletes a task so the controller can answer `204`
 *     (R5.1).
 *   - {@link memberBelongsToFamily} checks that an `assigned_member_id`
 *     references a member of the session family (R4.7).
 *
 * ### Which Supabase client
 *
 * Every operation uses the **service-role client**, matching the members and
 * family modules and the context resolver. All queries are keyed strictly by
 * the session-derived `familyId`, so no cross-family row is reachable even
 * though RLS is bypassed. By-id writes additionally scope the `WHERE` clause by
 * `family_id` as a second guard on top of the service-layer `assertOwned`
 * check, so a foreign/missing id can never be mutated or deleted.
 *
 * Task 6.2 (listing/filtering + move) adds its read/update queries here.
 */
import type { TaskRow } from '../../shared/types/index.js';
import { getServiceRoleClient } from '../../config/supabase.js';
import type { TaskStatus } from '../../shared/types/index.js';
import type {
  TaskCreateInput,
  TaskFilterInput,
  TaskUpdateInput,
} from './task.schemas.js';

/** Columns selected for a task row. */
const TASK_COLUMNS =
  'id, family_id, template_id, title, description, assigned_member_id, ' +
  'created_by_user_id, status, priority, points, due_date, due_time, ' +
  'week_start, carried_from_task_id, created_at, updated_at';

/**
 * Report whether `memberId` references a member of the given family.
 *
 * Used to enforce R4.7: a task may only be assigned to a member of the
 * session's own family. Keyed by both `id` and `family_id`, so a member in
 * another family (or a nonexistent one) returns `false` and the service raises
 * `422 VALIDATION`.
 *
 * @param familyId Session-derived `families.id`.
 * @param memberId The candidate `family_members.id` from the request body.
 */
export async function memberBelongsToFamily(
  familyId: string,
  memberId: string,
): Promise<boolean> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('family_members')
    .select('id')
    .eq('id', memberId)
    .eq('family_id', familyId)
    .maybeSingle<{ id: string }>();

  if (error) {
    throw error;
  }

  return data !== null;
}

/**
 * Insert a new task into the session's family and return the created row.
 *
 * `family_id` and `created_by_user_id` are taken from the session, never the
 * request (R4.2, R23.2). `status` and `priority` are only written when
 * supplied; `status` is never accepted on create (rejected by the schema's
 * `.strict()`), so it always falls through to the DB default of TODO, and an
 * omitted `priority` falls through to the DB default of MEDIUM (R4.1).
 *
 * @param familyId     Session-derived `families.id` (R4.2).
 * @param createdByUserId Session-derived `responsible_users.id` (R4.2).
 * @param input        The validated create body.
 */
export async function createTask(
  familyId: string,
  createdByUserId: string,
  input: TaskCreateInput,
): Promise<TaskRow> {
  const db = getServiceRoleClient();

  // Build the insert from derived identity + supplied fields only. `priority`
  // is omitted when absent so the column default (MEDIUM) applies; `status` is
  // never part of the create body, so the column default (TODO) always applies.
  const insert: Record<string, unknown> = {
    family_id: familyId,
    created_by_user_id: createdByUserId,
    title: input.title,
    description: input.description ?? null,
    assigned_member_id: input.assigned_member_id ?? null,
    points: input.points ?? 0,
    due_date: input.due_date ?? null,
    due_time: input.due_time ?? null,
    week_start: input.week_start ?? null,
  };

  if (input.priority !== undefined) {
    insert.priority = input.priority;
  }

  const { data, error } = await db
    .from('tasks')
    .insert(insert)
    .select(TASK_COLUMNS)
    .single<TaskRow>();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Load a single task by id, or `null` when no such row exists.
 *
 * Deliberately NOT scoped by `family_id`: the caller passes the row to
 * `assertOwned`, which collapses "not found" and "foreign family" into one
 * `404` so existence is never leaked (R5.2).
 *
 * @param id The `tasks.id` from the `:id` path param.
 */
export async function findTaskById(id: string): Promise<TaskRow | null> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('tasks')
    .select(TASK_COLUMNS)
    .eq('id', id)
    .maybeSingle<TaskRow>();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Apply a partial update to a task and return the updated row (R4.3).
 *
 * The `WHERE` clause is scoped by both `id` and the session `familyId` as a
 * belt-and-suspenders guard on top of the service-layer ownership check, so a
 * foreign task can never be mutated here. Only keys present in `patch` are
 * written.
 *
 * @param familyId Session-derived `families.id` (R5.2).
 * @param id       The task id to update.
 * @param patch    The validated, partial update body.
 */
export async function updateTask(
  familyId: string,
  id: string,
  patch: TaskUpdateInput,
): Promise<TaskRow> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('tasks')
    .update(patch)
    .eq('id', id)
    .eq('family_id', familyId)
    .select(TASK_COLUMNS)
    .single<TaskRow>();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * List the session family's tasks, applying only the filters that are present
 * (task 6.2, R6.1–R6.6).
 *
 * The query is ALWAYS keyed by `family_id` first, so the result is strictly
 * family-scoped regardless of which optional filters are supplied (R6.1). Each
 * provided filter adds an equality predicate: `date` → `due_date` (R6.2),
 * `weekStart` → `week_start` (R6.3), `status` (R6.4), `memberId` →
 * `assigned_member_id` (R6.5), `priority` (R6.6). Absent filters are not
 * applied. Results are ordered by `created_at` for a stable listing.
 *
 * @param familyId Session-derived `families.id` (R6.1).
 * @param filter   The validated, optional query filters.
 */
export async function listTasks(
  familyId: string,
  filter: TaskFilterInput,
): Promise<TaskRow[]> {
  const db = getServiceRoleClient();

  let query = db.from('tasks').select(TASK_COLUMNS).eq('family_id', familyId);

  if (filter.date !== undefined) {
    query = query.eq('due_date', filter.date);
  }
  if (filter.weekStart !== undefined) {
    query = query.eq('week_start', filter.weekStart);
  }
  if (filter.status !== undefined) {
    query = query.eq('status', filter.status);
  }
  if (filter.memberId !== undefined) {
    query = query.eq('assigned_member_id', filter.memberId);
  }
  if (filter.priority !== undefined) {
    query = query.eq('priority', filter.priority);
  }

  const { data, error } = await query
    .order('created_at', { ascending: true })
    .returns<TaskRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

/**
 * Set a task's `status` to a board column and return the updated row (task 6.2,
 * R7.1). The caller (service) has already loaded the task and run
 * {@link assertOwned}, and has rejected a DONE target. The `WHERE` is scoped by
 * both `id` and `family_id` as a second guard, so a foreign task can never be
 * mutated here.
 *
 * @param familyId Session-derived `families.id`.
 * @param id       The task id to move.
 * @param status   The target board status (never DONE — the service blocks it).
 */
export async function moveTask(
  familyId: string,
  id: string,
  status: TaskStatus,
): Promise<TaskRow> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('tasks')
    .update({ status })
    .eq('id', id)
    .eq('family_id', familyId)
    .select(TASK_COLUMNS)
    .single<TaskRow>();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * The period a carry-over run targets (task 9.3). Exactly one field is set,
 * mirroring the two addressing modes of {@link CarryOverInput}:
 *   - `targetWeekStart` → operate on the `week_start` column.
 *   - `targetDate` → operate on the `due_date` column.
 */
export type CarryOverTarget =
  | { kind: 'week'; targetWeekStart: string }
  | { kind: 'date'; targetDate: string };

/**
 * Find the session family's eligible unfinished prior-period tasks (task 9.3,
 * R14.1). "Eligible" means: in this family, status != 'DONE', and from a period
 * strictly BEFORE the target —
 *   - week mode: `week_start < targetWeekStart` (NULL week_start excluded);
 *   - date mode: `due_date < targetDate` (NULL due_date excluded).
 *
 * The query is always keyed by `family_id` first, so no cross-family row is
 * reachable even though the service role bypasses RLS. The `<` comparison on
 * the stored `YYYY-MM-DD` date columns is a lexicographic/date compare that
 * excludes the target period itself (so re-running on the same period never
 * re-selects the just-created carried tasks).
 *
 * @param familyId Session-derived `families.id`.
 * @param target   The resolved carry-over target period.
 */
export async function findCarryOverCandidates(
  familyId: string,
  target: CarryOverTarget,
): Promise<TaskRow[]> {
  const db = getServiceRoleClient();

  let query = db
    .from('tasks')
    .select(TASK_COLUMNS)
    .eq('family_id', familyId)
    .neq('status', 'DONE');

  if (target.kind === 'week') {
    query = query.not('week_start', 'is', null).lt('week_start', target.targetWeekStart);
  } else {
    query = query.not('due_date', 'is', null).lt('due_date', target.targetDate);
  }

  const { data, error } = await query
    .order('created_at', { ascending: true })
    .returns<TaskRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

/**
 * Return the set of origin task ids that have ALREADY been carried over into
 * the target period (task 9.3, R14.3). A task already carried for the target is
 * one in the family whose `carried_from_task_id` is in `originIds` AND whose
 * own period matches the target (`week_start = targetWeekStart` or
 * `due_date = targetDate`). The caller uses this set to skip those origins so
 * the same origin is never carried twice for the same period.
 *
 * Returns an empty set when there are no candidates to check.
 *
 * @param familyId  Session-derived `families.id`.
 * @param target    The resolved carry-over target period.
 * @param originIds The candidate origin task ids.
 */
export async function findAlreadyCarried(
  familyId: string,
  target: CarryOverTarget,
  originIds: string[],
): Promise<Set<string>> {
  if (originIds.length === 0) {
    return new Set();
  }

  const db = getServiceRoleClient();

  let query = db
    .from('tasks')
    .select('carried_from_task_id')
    .eq('family_id', familyId)
    .in('carried_from_task_id', originIds);

  if (target.kind === 'week') {
    query = query.eq('week_start', target.targetWeekStart);
  } else {
    query = query.eq('due_date', target.targetDate);
  }

  const { data, error } = await query.returns<{ carried_from_task_id: string | null }[]>();

  if (error) {
    throw error;
  }

  const seen = new Set<string>();
  for (const row of data ?? []) {
    if (typeof row.carried_from_task_id === 'string') {
      seen.add(row.carried_from_task_id);
    }
  }
  return seen;
}

/** A single carried-over task insert payload (task 9.3). */
export interface CarriedTaskInsert {
  family_id: string;
  created_by_user_id: string;
  title: string;
  description: string | null;
  assigned_member_id: string | null;
  points: number;
  priority: TaskRow['priority'];
  status: TaskRow['status'];
  due_date: string | null;
  week_start: string | null;
  carried_from_task_id: string;
}

/**
 * Bulk-insert the carried-over tasks and return the created rows (task 9.3,
 * R14.1/R14.2). A single family-scoped insert covers all rows; an empty list is
 * a no-op returning `[]`. Every row carries the session-derived `family_id` and
 * `created_by_user_id` and a `carried_from_task_id` linking it to its origin.
 *
 * @param rows The carried-task insert payloads (already deduped by the service).
 */
export async function insertCarriedTasks(
  rows: CarriedTaskInsert[],
): Promise<TaskRow[]> {
  if (rows.length === 0) {
    return [];
  }

  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('tasks')
    .insert(rows)
    .select(TASK_COLUMNS)
    .returns<TaskRow[]>();

  if (error) {
    throw error;
  }

  return data ?? [];
}

/**
 * Hard-delete a task so the controller can answer `204` (R5.1).
 *
 * Scoped by `id` + `familyId` as a second guard on top of the service-layer
 * ownership check, so a foreign/missing id can never be deleted.
 *
 * @param familyId Session-derived `families.id` (R5.2).
 * @param id       The task id to delete.
 */
export async function deleteTask(familyId: string, id: string): Promise<void> {
  const db = getServiceRoleClient();

  const { error } = await db
    .from('tasks')
    .delete()
    .eq('id', id)
    .eq('family_id', familyId);

  if (error) {
    throw error;
  }
}
