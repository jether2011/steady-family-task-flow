/**
 * Tasks domain API module.
 *
 * Wraps the backend "Tasks module" (CRUD + move/complete/reopen/carry-over)
 * with typed functions calling `client.ts`.
 *
 * Response-envelope assumptions (design "REST API Design"):
 *   GET    /family/tasks            -> { tasks: Task[] }      (unwrapped -> Task[])
 *   POST   /family/tasks            -> 201 { task }           (unwrapped -> Task)
 *   PATCH  /tasks/:id               -> { task }               (unwrapped -> Task)
 *   DELETE /tasks/:id               -> 204 (no body)          (resolves void)
 *   POST   /tasks/:id/move          -> { task }               (unwrapped -> Task)
 *   POST   /tasks/:id/complete      -> 201 CompleteTaskPayload (returned whole)
 *   POST   /tasks/:id/reopen        -> 200 ReopenTaskPayload   (returned whole)
 *   POST   /family/tasks/carry-over -> { created }            (returned whole)
 */

import { get, post, patch, del } from './client';
import type {
  Task,
  TaskFilter,
  TaskCreate,
  TaskUpdate,
  TaskMove,
  TaskComplete,
  CarryOver,
  CarryOverResult,
  CompleteTaskPayload,
  ReopenTaskPayload,
} from './types';

interface TasksEnvelope {
  tasks: Task[];
}

interface TaskEnvelope {
  task: Task;
}

/**
 * `GET /family/tasks` — filtered task list. All filter fields are optional and
 * null/undefined values are dropped by the client's query serializer.
 */
export async function list(
  filter: TaskFilter = {},
  signal?: AbortSignal,
): Promise<Task[]> {
  const res = await get<TasksEnvelope>(
    '/family/tasks',
    { ...filter },
    signal,
  );
  return res.tasks;
}

/** `POST /family/tasks` — create a task. Unwraps `{ task }` → Task. */
export async function create(
  body: TaskCreate,
  signal?: AbortSignal,
): Promise<Task> {
  const res = await post<TaskEnvelope>('/family/tasks', body, signal);
  return res.task;
}

/** `PATCH /tasks/:id` — update a task. Unwraps `{ task }` → Task. */
export async function update(
  id: string,
  body: TaskUpdate,
  signal?: AbortSignal,
): Promise<Task> {
  const res = await patch<TaskEnvelope>(`/tasks/${id}`, body, signal);
  return res.task;
}

/** `DELETE /tasks/:id` — hard delete. Backend answers 204 → resolves void. */
export function remove(id: string, signal?: AbortSignal): Promise<void> {
  return del<void>(`/tasks/${id}`, signal);
}

/**
 * `POST /tasks/:id/move` — move a task between non-DONE columns. (DONE is
 * reached only via `complete`; the backend rejects it with 422.) Unwraps
 * `{ task }` → Task.
 */
export async function move(
  id: string,
  body: TaskMove,
  signal?: AbortSignal,
): Promise<Task> {
  const res = await post<TaskEnvelope>(`/tasks/${id}/move`, body, signal);
  return res.task;
}

/**
 * `POST /tasks/:id/complete` — mark a task done and award points. Returns the
 * full `CompleteTaskPayload` (task status, completion, points awarded) since
 * callers surface the awarded points.
 */
export function complete(
  id: string,
  body: TaskComplete,
  signal?: AbortSignal,
): Promise<CompleteTaskPayload> {
  return post<CompleteTaskPayload>(`/tasks/${id}/complete`, body, signal);
}

/**
 * `POST /tasks/:id/reopen` — reopen a completed task and reverse its points.
 * Returns the full `ReopenTaskPayload` (task + reversedPoints).
 */
export function reopen(
  id: string,
  signal?: AbortSignal,
): Promise<ReopenTaskPayload> {
  return post<ReopenTaskPayload>(`/tasks/${id}/reopen`, undefined, signal);
}

/**
 * `POST /family/tasks/carry-over` — carry incomplete tasks to a target
 * date/week. Returns the full `{ created }` result.
 */
export function carryOver(
  body: CarryOver,
  signal?: AbortSignal,
): Promise<CarryOverResult> {
  return post<CarryOverResult>('/family/tasks/carry-over', body, signal);
}

export const tasks = {
  list,
  create,
  update,
  remove,
  move,
  complete,
  reopen,
  carryOver,
};
