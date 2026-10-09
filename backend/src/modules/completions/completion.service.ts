/**
 * Completion service — business logic behind `POST /tasks/:id/complete`
 * (task 7.1).
 *
 * Enforces the completion rules IN CODE, in a precise order, so each failure
 * surfaces the exact Error_Contract code — the pre-RPC checks exist so the API
 * returns `403`/`422`/`404` distinctly rather than collapsing everything into
 * the RPC's generic exceptions:
 *
 *   1. Body validation (`completedByMemberId` present + uuid) is already done by
 *      the route's Zod schema → missing/empty → `422 VALIDATION` (R8.5).
 *   2. Load the task; a missing/foreign task → `404 NOT_FOUND` via
 *      {@link assertOwned} (R8.8).
 *   3. Load the member; a nonexistent member OR one whose `family_id` differs
 *      from the task's → `403 FORBIDDEN` (R8.7); an `active === false` member →
 *      `422 VALIDATION` (R8.6). No Task_Completion or ledger row is written on
 *      either failure.
 *   4. An already-DONE task → `409 TASK_ALREADY_COMPLETED` (R9.2). The RPC also
 *      enforces this (and the UNIQUE(task_id) duplicate race), so this early
 *      check is a fast path and the RPC remains the atomic source of truth.
 *
 * Only after all checks pass does it call the atomic `complete_task` RPC via the
 * service-role client, which derives `points` from the stored task, inserts the
 * ledger row only when `points > 0`, sets DONE, credits the supplied member, and
 * records the responsible user as the actor — all atomically (R8.3/R8.4,
 * R10.2–R10.6, R23.6).
 *
 * Identity (`familyId`, `responsibleUserId`) always arrives from the caller's
 * resolved session context, never from the request body (R8.3, R23.2); the
 * controller passes it in from `requireFamilyContext`.
 */
import { assertOwned } from '../../middleware/authorization.js';
import { STATUS } from '../../shared/constants/index.js';
import {
  Conflict,
  Forbidden,
  NotFound,
  ValidationError,
} from '../../shared/errors/index.js';
import type {
  CompleteTaskPayload,
  ReopenTaskPayload,
  TaskDTO,
  TaskRow,
} from '../../shared/types/index.js';
import {
  completeTaskRpc,
  findMemberById,
  findTaskById,
  reopenTaskRpc,
} from './completion.repository.js';
import type { TaskCompleteInput } from './completion.schemas.js';

/** The resolved, non-null identity a completion operation needs. */
interface CompletionContext {
  familyId: string;
  responsibleUserId: string;
}

/**
 * Map a `tasks` row to the public {@link TaskDTO} (drops timestamps), matching
 * the tasks module's mapper so the reopen payload carries the exact same `Task`
 * shape the frontend expects.
 */
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
 * Complete a task on behalf of a family member, awarding its points atomically
 * (R8.1).
 *
 * Runs the ownership + validation checks in the documented order so the error
 * codes are precise, then invokes the `complete_task` RPC. On success it shapes
 * the `201` payload EXACTLY as `{ task:{ id, status:'DONE', completedAt },
 * completion:{ completedByMemberId }, points:{ awarded } }` (R8.2), pulling
 * `completedAt` and `awarded` from the RPC result (the server-derived truth).
 *
 * @param ctx  Session-derived identity (`familyId`, `responsibleUserId`).
 * @param id   The task id from the `:id` path param.
 * @param body The validated body carrying `completedByMemberId`.
 */
export async function complete(
  ctx: CompletionContext,
  id: string,
  body: TaskCompleteInput,
): Promise<CompleteTaskPayload> {
  // 2. Task ownership — missing/foreign task → 404 (R8.8).
  const task = await findTaskById(id);
  assertOwned(task?.family_id, ctx.familyId);

  // 3. Member checks — ordered so family membership (403) is decided before
  //    activeness (422). A nonexistent member OR one outside the task's family
  //    → 403 FORBIDDEN (R8.7); an inactive member → 422 VALIDATION (R8.6).
  const member = await findMemberById(body.completedByMemberId);
  if (member === null || member.family_id !== task!.family_id) {
    throw new Forbidden('Member does not belong to this family');
  }
  if (member.active === false) {
    throw new ValidationError('Member is inactive');
  }

  // 4. Already-DONE fast path → 409 (R9.2). The RPC re-enforces this atomically.
  if (task!.status === STATUS.DONE) {
    throw new Conflict();
  }

  // All checks passed — perform the atomic completion. The RPC derives points
  // from the stored task, writes the ledger row only when points > 0, sets
  // DONE, and maps a duplicate/race back to 409 (R9.3, R10.2–R10.6, R23.6).
  const result = await completeTaskRpc(
    task!.id,
    body.completedByMemberId,
    ctx.responsibleUserId,
  );

  return {
    task: {
      id: task!.id,
      status: 'DONE',
      completedAt: result.completedAt,
    },
    completion: {
      completedByMemberId: result.completedByMemberId,
    },
    points: {
      awarded: result.awarded,
    },
  };
}

/**
 * Reopen a completed task, reversing its points atomically (R11.1).
 *
 * Runs the ownership + status checks in order so the error codes are precise,
 * then invokes the `reopen_task` RPC:
 *
 *   1. Load the task; a missing/foreign task → `404 NOT_FOUND` via
 *      {@link assertOwned} (R11.8).
 *   2. A non-DONE task → `422 VALIDATION` (R11.4) — a fast, precise code. The
 *      RPC re-checks this atomically (raising `NOT_DONE`), so it remains correct
 *      even if a concurrent reopen moved the task off DONE first.
 *   3. Call the atomic RPC: it deletes the Task_Completion, KEEPS the original
 *      TASK_COMPLETION ledger row, writes a REVERSAL of the negated award only
 *      when it was > 0 (0 → no REVERSAL, `reversedPoints` 0, R11.2/R11.3/R11.5),
 *      flips the task to TODO (re-arming re-completion, R11.7), and lets the
 *      derived total go negative (R11.10).
 *
 * The RPC returns only the new status + `reversedPoints`, so the task row is
 * re-read to return the FULL updated task in the payload (what the frontend
 * `tasks.api.reopen` expects). `reversedPoints` is non-negative (R11.1).
 *
 * @param ctx Session-derived identity (`familyId`, `responsibleUserId`).
 * @param id  The task id from the `:id` path param.
 */
export async function reopen(
  ctx: CompletionContext,
  id: string,
): Promise<ReopenTaskPayload> {
  // 1. Task ownership — missing/foreign task → 404 (R11.8).
  const task = await findTaskById(id);
  assertOwned(task?.family_id, ctx.familyId);

  // 2. Only a DONE task may be reopened → non-DONE is 422 (R11.4). The RPC
  //    re-enforces this atomically.
  if (task!.status !== STATUS.DONE) {
    throw new ValidationError('Task is not completed');
  }

  // 3. Perform the atomic reopen + reversal.
  const result = await reopenTaskRpc(task!.id);

  // Re-read the task so the client gets the full updated row (status → TODO).
  const updated = await findTaskById(task!.id);
  if (updated === null) {
    throw new NotFound();
  }

  return {
    task: toTaskDTO(updated),
    reversedPoints: result.reversedPoints,
  };
}
