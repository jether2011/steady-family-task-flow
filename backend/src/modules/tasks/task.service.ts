/**
 * Task service — business logic behind the task routes (CRUD slice, task 6.1).
 *
 * Owns the task create/update/delete rules: it maps a `tasks` row to the
 * frontend {@link TaskDTO} shape, enforces family ownership for by-id
 * operations by loading the row and running {@link assertOwned} (foreign/
 * missing `:id` → `404 NOT_FOUND`, R5.2), and enforces the
 * assigned-member-in-family rule (R4.7): any `assigned_member_id` supplied on
 * create or update must reference a member of the session's own family, else
 * `422 VALIDATION`. It holds no Supabase calls itself — all persistence goes
 * through `task.repository.ts`.
 *
 * Identity (`familyId`, `responsibleUserId`) always arrives from the caller's
 * resolved session context, never from the request body (R4.2, R23.2); the
 * controller passes it in from `requireFamilyContext`.
 *
 * Task 6.2 (listing/filtering + move) adds its list/move logic here.
 */
import { assertOwned } from '../../middleware/authorization.js';
import { STATUS } from '../../shared/constants/index.js';
import { ValidationError } from '../../shared/errors/index.js';
import type { TaskDTO, TaskRow } from '../../shared/types/index.js';
import {
  createTask,
  deleteTask,
  findAlreadyCarried,
  findCarryOverCandidates,
  findTaskById,
  insertCarriedTasks,
  listTasks,
  memberBelongsToFamily,
  moveTask,
  updateTask,
} from './task.repository.js';
import type {
  CarriedTaskInsert,
  CarryOverTarget,
} from './task.repository.js';
import type {
  CarryOverInput,
  TaskCreateInput,
  TaskFilterInput,
  TaskMoveInput,
  TaskUpdateInput,
} from './task.schemas.js';

/** The resolved, non-null identity a task operation needs. */
interface TaskContext {
  familyId: string;
  responsibleUserId: string;
}

/** Map a `tasks` row to the public {@link TaskDTO} (drops timestamps). */
function toTaskDTO(row: TaskRow): TaskDTO {
  return {
    id: row.id,
    family_id: row.family_id,
    template_id: row.template_id,
    title: row.title,
    description: row.description,
    assigned_member_id: row.assigned_member_id,
    created_by_user_id: row.created_by_user_id,
    status: row.status,
    priority: row.priority,
    points: row.points,
    due_date: row.due_date,
    due_time: row.due_time,
    week_start: row.week_start,
    carried_from_task_id: row.carried_from_task_id,
  };
}

/**
 * Verify that an `assigned_member_id`, when present and non-null, belongs to
 * the session's family (R4.7). A member in another family or a nonexistent one
 * raises `422 VALIDATION`. A `null`/`undefined` assignee is left untouched
 * (unassigning or not touching the field is always allowed).
 *
 * @param familyId Session-derived `families.id`.
 * @param memberId The candidate assignee from the request body, if any.
 */
async function assertAssigneeInFamily(
  familyId: string,
  memberId: string | null | undefined,
): Promise<void> {
  if (typeof memberId !== 'string') {
    return;
  }
  const ok = await memberBelongsToFamily(familyId, memberId);
  if (!ok) {
    throw new ValidationError('assigned_member_id does not belong to this family');
  }
}

/**
 * Create a task in the session family with `status` defaulting to TODO and
 * `priority` defaulting to MEDIUM (R4.1).
 *
 * `family_id` and `created_by_user_id` are taken from `ctx`, never the body
 * (R4.2, R23.2); a client-supplied `status`/`family_id`/`created_by_user_id`
 * was already rejected as `422` by the schema's `.strict()`. An invalid
 * `priority`/`points` was already rejected as `422` by Zod (R4.5/R4.6). A
 * non-family `assigned_member_id` is rejected here as `422` (R4.7).
 *
 * @param ctx  Session-derived identity.
 * @param body The validated create body.
 */
export async function create(
  ctx: TaskContext,
  body: TaskCreateInput,
): Promise<TaskDTO> {
  await assertAssigneeInFamily(ctx.familyId, body.assigned_member_id);
  const row = await createTask(ctx.familyId, ctx.responsibleUserId, body);
  return toTaskDTO(row);
}

/**
 * Update a task in the session family and return the updated record (R4.3).
 *
 * The target is first loaded and checked with {@link assertOwned}: a missing id
 * or one belonging to another family both become `404 NOT_FOUND` (R5.2).
 * Invalid `status`/`priority`/`points` were already rejected as `422` by Zod
 * (R4.4/R4.5/R4.6). A non-family `assigned_member_id` is rejected here as `422`
 * (R4.7).
 *
 * @param ctx  Session-derived identity.
 * @param id   The task id from the `:id` path param.
 * @param body The validated partial update body.
 */
export async function update(
  ctx: TaskContext,
  id: string,
  body: TaskUpdateInput,
): Promise<TaskDTO> {
  const existing = await findTaskById(id);
  assertOwned(existing?.family_id, ctx.familyId);

  await assertAssigneeInFamily(ctx.familyId, body.assigned_member_id);

  const row = await updateTask(ctx.familyId, id, body);
  return toTaskDTO(row);
}

/**
 * Delete a task in the session family (R5.1). The controller answers `204`.
 *
 * The target is first loaded and checked with {@link assertOwned}, so a
 * missing/foreign id becomes `404 NOT_FOUND` (R5.2).
 *
 * @param ctx Session-derived identity.
 * @param id  The task id from the `:id` path param.
 */
export async function remove(ctx: TaskContext, id: string): Promise<void> {
  const existing = await findTaskById(id);
  assertOwned(existing?.family_id, ctx.familyId);

  await deleteTask(ctx.familyId, id);
}

/**
 * List the session family's tasks, applying only the supplied filters (task
 * 6.2, R6.1–R6.6). Every result is strictly family-scoped (R6.1); invalid
 * filter values were already rejected as `422` by the query schema (R6.7).
 *
 * @param ctx    Session-derived identity.
 * @param filter The validated, optional query filters.
 */
export async function list(
  ctx: TaskContext,
  filter: TaskFilterInput,
): Promise<TaskDTO[]> {
  const rows = await listTasks(ctx.familyId, filter);
  return rows.map(toTaskDTO);
}

/**
 * Move a task between board columns (task 6.2, R7.1–R7.2).
 *
 * The target is first loaded and checked with {@link assertOwned}: a missing id
 * or one belonging to another family both become `404 NOT_FOUND`. A target of
 * DONE is rejected with `422 VALIDATION` carrying a message that directs the
 * caller to the completion endpoint (R7.2) — DONE is only reachable via
 * `POST /tasks/:id/complete`, which also records the completion and awards
 * points. A truly out-of-enum target was already rejected as `422` by the
 * schema (R7.3). Any accepted value is one of {BACKLOG, TODO, WORKING}, which
 * is set verbatim (R7.1).
 *
 * @param ctx  Session-derived identity.
 * @param id   The task id from the `:id` path param.
 * @param body The validated move body carrying the target `status`.
 */
export async function move(
  ctx: TaskContext,
  id: string,
  body: TaskMoveInput,
): Promise<TaskDTO> {
  if (body.status === STATUS.DONE) {
    throw new ValidationError(
      'Use the completion endpoint (POST /tasks/:id/complete) to mark a task DONE',
    );
  }

  const existing = await findTaskById(id);
  assertOwned(existing?.family_id, ctx.familyId);

  const row = await moveTask(ctx.familyId, id, body.status);
  return toTaskDTO(row);
}

/**
 * Resolve the validated carry-over body to a single repository target. The
 * schema's `.refine` guarantees at least one field is present; when both are
 * supplied, `targetWeekStart` wins (the weekly board is the coarser period and
 * the primary carry-over surface).
 */
function resolveCarryOverTarget(body: CarryOverInput): CarryOverTarget {
  if (body.targetWeekStart !== undefined) {
    return { kind: 'week', targetWeekStart: body.targetWeekStart };
  }
  // Safe: refine guarantees targetDate is present when targetWeekStart is not.
  return { kind: 'date', targetDate: body.targetDate as string };
}

/**
 * Carry eligible unfinished prior-period tasks into a target period (task 9.3,
 * R14.1–R14.3).
 *
 * For each eligible origin — a task in the session family with status != DONE
 * from a period strictly before the target (see
 * {@link findCarryOverCandidates}) — one new task is created with
 * `carried_from_task_id` set to the origin, copying the origin's
 * `title`/`description`/`assigned_member_id`/`points`/`priority`. `family_id`
 * and `created_by_user_id` are taken from `ctx`, never the body (R14.2,
 * R23.2); the new task's status is reset to TODO and its period
 * (`due_date`/`week_start`) is set to the target.
 *
 * Idempotency (R14.3): before inserting, origins that already have a carried
 * copy in the target period (origin ⇒ existing task in that period whose
 * `carried_from_task_id` equals the origin) are skipped, so re-running
 * carry-over for the same period never duplicates. The `<` lower bound in the
 * candidate query also excludes the target period itself, so the just-created
 * carried tasks are never re-selected on a subsequent run.
 *
 * @param ctx  Session-derived identity.
 * @param body The validated carry-over body (at least one target present).
 * @returns `{ created }` — the number of new carried-over tasks created.
 */
export async function carryOver(
  ctx: TaskContext,
  body: CarryOverInput,
): Promise<{ created: number }> {
  const target = resolveCarryOverTarget(body);

  const candidates = await findCarryOverCandidates(ctx.familyId, target);
  if (candidates.length === 0) {
    return { created: 0 };
  }

  const originIds = candidates.map((c) => c.id);
  const alreadyCarried = await findAlreadyCarried(ctx.familyId, target, originIds);

  const targetDueDate = target.kind === 'date' ? target.targetDate : null;
  const targetWeekStart = target.kind === 'week' ? target.targetWeekStart : null;

  const toInsert: CarriedTaskInsert[] = candidates
    .filter((origin) => !alreadyCarried.has(origin.id))
    .map((origin) => ({
      family_id: ctx.familyId,
      created_by_user_id: ctx.responsibleUserId,
      title: origin.title,
      description: origin.description,
      assigned_member_id: origin.assigned_member_id,
      points: origin.points,
      priority: origin.priority,
      status: STATUS.TODO,
      due_date: targetDueDate,
      week_start: targetWeekStart,
      carried_from_task_id: origin.id,
    }));

  const created = await insertCarriedTasks(toInsert);
  return { created: created.length };
}
