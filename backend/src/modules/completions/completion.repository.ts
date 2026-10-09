/**
 * Completion repository — the ONLY layer in this module that talks to Supabase
 * (task 7.1).
 *
 * Backs the task-completion slice:
 *   - {@link findTaskById} loads the target task so the service can enforce
 *     family ownership (foreign/missing → `404`, R8.8) and read the stored
 *     `points`/`status` BEFORE any write.
 *   - {@link findMemberById} loads the `completedByMemberId` member so the
 *     service can enforce the family + active checks (R8.6/R8.7).
 *   - {@link completeTaskRpc} invokes the atomic `complete_task` plpgsql RPC
 *     (migration `004_functions.sql`) via the service-role client. The RPC
 *     derives points from the stored task, inserts the ledger row only when
 *     `points > 0`, flips the task to DONE, and does it all in one transaction
 *     (R10.2–R10.6). Raised exceptions are mapped to the shared error classes
 *     here (R9.3).
 *
 * ### Which Supabase client
 *
 * Reads and the RPC both use the **service-role client**, matching the tasks /
 * members modules and the context resolver. The service layer enforces family
 * ownership in code BEFORE the RPC is called (R23.6), so the privileged client
 * never acts on a cross-family row.
 */
import { PostgrestError } from '@supabase/supabase-js';

import { getServiceRoleClient } from '../../config/supabase.js';
import {
  Conflict,
  NotFound,
  ValidationError,
} from '../../shared/errors/index.js';
import type { FamilyMemberRow, TaskRow } from '../../shared/types/index.js';

/** Columns selected for a task row (mirrors the tasks module). */
const TASK_COLUMNS =
  'id, family_id, template_id, title, description, assigned_member_id, ' +
  'created_by_user_id, status, priority, points, due_date, due_time, ' +
  'week_start, carried_from_task_id, created_at, updated_at';

/** Columns selected for a family member row (mirrors the members module). */
const MEMBER_COLUMNS =
  'id, family_id, name, member_type, avatar_url, color, birth_year, active, created_at, updated_at';

/**
 * The jsonb summary returned by the `complete_task` RPC.
 * `completedAt` is an ISO timestamp; `awarded` is the point amount recorded in
 * the ledger (0 when the task was worth 0 points — R10.3).
 */
export interface CompleteTaskRpcResult {
  status: 'DONE';
  completedAt: string;
  completedByMemberId: string;
  awarded: number;
}

/**
 * The jsonb summary returned by the `reopen_task` RPC.
 * `reversedPoints` is the non-negative magnitude of the reversal (0 when the
 * original award was 0, in which case no REVERSAL row was written — R11.5).
 */
export interface ReopenTaskRpcResult {
  status: 'TODO';
  reversedPoints: number;
}

/**
 * Load a single task by id, or `null` when no such row exists.
 *
 * Deliberately NOT scoped by `family_id`: the caller passes the row to
 * `assertOwned`, which collapses "not found" and "foreign family" into one
 * `404` so existence is never leaked (R8.8).
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
 * Load a single family member by id, or `null` when no such row exists.
 *
 * NOT scoped by `family_id`: the service compares the member's `family_id`
 * against the task's family itself so a member in another family becomes a
 * `403 FORBIDDEN` (R8.7), distinct from the task-not-found `404`.
 *
 * @param id The `family_members.id` supplied as `completedByMemberId`.
 */
export async function findMemberById(
  id: string,
): Promise<FamilyMemberRow | null> {
  const db = getServiceRoleClient();

  const { data, error } = await db
    .from('family_members')
    .select(MEMBER_COLUMNS)
    .eq('id', id)
    .maybeSingle<FamilyMemberRow>();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Match a Supabase RPC error against a named plpgsql exception.
 *
 * The RPCs `raise exception '<NAME>'`, which surfaces on the Supabase error as
 * a message like `<NAME>` (PostgreSQL `raise_exception`, SQLSTATE `P0001`). The
 * `unique_violation` race path is re-raised by the RPC as
 * `TASK_ALREADY_COMPLETED`, so matching the message covers both the status
 * pre-check loss and the duplicate-insert race (R9.3).
 */
function rpcErrorIs(error: PostgrestError, name: string): boolean {
  return error.message.includes(name);
}

/**
 * Invoke the atomic `complete_task` RPC and return its jsonb summary (R10.4,
 * R10.5).
 *
 * The RPC runs as one transaction: it locks the task row, re-checks it is not
 * already DONE, inserts the Task_Completion (UNIQUE(task_id) backstops
 * duplicates), inserts the TASK_COMPLETION ledger row ONLY when the stored
 * `points > 0` (R10.2/R10.3/R10.6), and flips the task to DONE. `points`,
 * `completed_by_user_id`, and `family_id` are all derived inside the RPC from
 * the stored task — never from the client (R23.6).
 *
 * Raised exceptions are mapped to the shared error classes so the Error_Contract
 * reports the right code:
 *   - `TASK_ALREADY_COMPLETED` (status pre-check OR the UNIQUE(task_id) race) →
 *     {@link Conflict} (`409`, R9.3) — the transaction rolled back, so no extra
 *     ledger entry was written.
 *   - `NOT_FOUND` → {@link NotFound} (`404`).
 *
 * @param taskId            The verified-owned task id.
 * @param memberId          The `completedByMemberId` (becomes
 *   `completed_by_member_id`, R8.4).
 * @param responsibleUserId The session's responsible user (becomes
 *   `completed_by_user_id`, R8.3).
 */
export async function completeTaskRpc(
  taskId: string,
  memberId: string,
  responsibleUserId: string,
): Promise<CompleteTaskRpcResult> {
  const db = getServiceRoleClient();

  const { data, error } = await db.rpc('complete_task', {
    p_task_id: taskId,
    p_member_id: memberId,
    p_responsible_user_id: responsibleUserId,
  });

  if (error) {
    if (rpcErrorIs(error, 'TASK_ALREADY_COMPLETED')) {
      throw new Conflict();
    }
    if (rpcErrorIs(error, 'NOT_FOUND')) {
      throw new NotFound();
    }
    throw error;
  }

  return data as CompleteTaskRpcResult;
}

/**
 * Invoke the atomic `reopen_task` RPC and return its jsonb summary (R11.1,
 * R11.6).
 *
 * The RPC runs as one transaction: it locks the task row, re-checks it is
 * currently DONE, deletes the single Task_Completion while KEEPING the original
 * TASK_COMPLETION ledger row, appends a REVERSAL of the negated original award
 * ONLY when that award was > 0 (R11.2/R11.3/R11.5), flips the task back to TODO
 * — which re-arms UNIQUE(task_id) so the task can be completed again (R11.7) —
 * and allows the derived total to go negative (R11.10). It returns
 * `{ status:'TODO', reversedPoints }`.
 *
 * Raised exceptions are mapped to the shared error classes so the
 * Error_Contract reports the right code:
 *   - `NOT_DONE` (the task was not DONE) → {@link ValidationError} (`422`,
 *     R11.4). The service also pre-checks this for a fast, precise `422`; this
 *     mapping keeps the RPC correct as the atomic source of truth even under a
 *     concurrent reopen that already moved the task off DONE.
 *   - `NOT_FOUND` → {@link NotFound} (`404`).
 *
 * This returns only the new status + `reversedPoints`; the service re-reads the
 * task via {@link findTaskById} to return the FULL updated task to the client.
 *
 * @param taskId The verified-owned task id.
 */
export async function reopenTaskRpc(
  taskId: string,
): Promise<ReopenTaskRpcResult> {
  const db = getServiceRoleClient();

  const { data, error } = await db.rpc('reopen_task', {
    p_task_id: taskId,
  });

  if (error) {
    if (rpcErrorIs(error, 'NOT_DONE')) {
      throw new ValidationError('Task is not completed');
    }
    if (rpcErrorIs(error, 'NOT_FOUND')) {
      throw new NotFound();
    }
    throw error;
  }

  return data as ReopenTaskRpcResult;
}
