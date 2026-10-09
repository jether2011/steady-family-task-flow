/**
 * Task controller — HTTP glue for the task CRUD routes (task 6.1).
 *
 * Controllers translate between HTTP and the service layer. Identity is read
 * EXCLUSIVELY from the resolved session context via `requireFamilyContext`
 * (which turns a not-yet-bootstrapped family into `404 NOT_FOUND`), never from
 * the request body, query, or headers (R4.2, R23.2). Bodies and path params
 * have already been validated/parsed by each route's Zod schema, so an invalid
 * `status`/`priority`/`points` (`422` — R4.4/R4.5/R4.6), a client-supplied
 * `status`/`family_id` on create (rejected by `.strict()` — R4.2), or a
 * non-uuid `:id` never reaches here; the handlers just forward the typed input
 * to the service.
 *
 * Task 6.2 (listing/filtering + move) adds its handlers here.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireFamilyContext } from '../../middleware/context.js';
import type { TaskDTO } from '../../shared/types/index.js';
import { carryOver, create, list, move, remove, update } from './task.service.js';
import type {
  CarryOverInput,
  TaskCreateInput,
  TaskFilterInput,
  TaskIdParamsInput,
  TaskMoveInput,
  TaskUpdateInput,
} from './task.schemas.js';

/**
 * `GET /api/v1/family/tasks` → `{ tasks }` (R6.1–R6.6). All filters are
 * optional and family-scoped; invalid filter values were already rejected as
 * `422` by the query schema (R6.7). Matches the frontend `tasks.api.list`
 * envelope.
 */
export async function listTasksHandler(
  request: FastifyRequest<{ Querystring: TaskFilterInput }>,
  _reply: FastifyReply,
): Promise<{ tasks: TaskDTO[] }> {
  const { familyId, responsibleUserId } = requireFamilyContext(request);
  const tasks = await list({ familyId, responsibleUserId }, request.query);
  return { tasks };
}

/**
 * `POST /api/v1/tasks/:id/move` → `{ task }` (R7.1). A target of DONE → `422`
 * directing the caller to the completion endpoint (R7.2); an out-of-enum target
 * → `422` from the schema (R7.3); a foreign/missing id → `404` (R23.3). Matches
 * the frontend `tasks.api.move` envelope.
 */
export async function moveTaskHandler(
  request: FastifyRequest<{ Params: TaskIdParamsInput; Body: TaskMoveInput }>,
  _reply: FastifyReply,
): Promise<{ task: TaskDTO }> {
  const { familyId, responsibleUserId } = requireFamilyContext(request);
  const task = await move({ familyId, responsibleUserId }, request.params.id, request.body);
  return { task };
}

/**
 * `POST /api/v1/family/tasks/carry-over` → `{ created }` (task 9.3, R14.1–R14.3).
 * Carries the family's eligible unfinished prior-period tasks into the target
 * period, skipping origins already carried for that period (R14.3). Identity
 * (`family_id`, `created_by_user_id`) comes from the session context, never the
 * body (R14.2, R23.2). An empty body (no target) was already rejected as `422`
 * by the schema. Matches the frontend `tasks.api.carryOver` envelope.
 */
export async function carryOverHandler(
  request: FastifyRequest<{ Body: CarryOverInput }>,
  _reply: FastifyReply,
): Promise<{ created: number }> {
  const { familyId, responsibleUserId } = requireFamilyContext(request);
  return carryOver({ familyId, responsibleUserId }, request.body);
}

/** `POST /api/v1/family/tasks` → `201 { task }` (R4.1). */
export async function createTaskHandler(
  request: FastifyRequest<{ Body: TaskCreateInput }>,
  reply: FastifyReply,
): Promise<{ task: TaskDTO }> {
  const { familyId, responsibleUserId } = requireFamilyContext(request);
  const task = await create({ familyId, responsibleUserId }, request.body);
  void reply.code(201);
  return { task };
}

/** `PATCH /api/v1/tasks/:id` → `{ task }` (R4.3; foreign id → 404, R5.2). */
export async function updateTaskHandler(
  request: FastifyRequest<{ Params: TaskIdParamsInput; Body: TaskUpdateInput }>,
  _reply: FastifyReply,
): Promise<{ task: TaskDTO }> {
  const { familyId, responsibleUserId } = requireFamilyContext(request);
  const task = await update({ familyId, responsibleUserId }, request.params.id, request.body);
  return { task };
}

/**
 * `DELETE /api/v1/tasks/:id` → `204` with no body (hard delete, R5.1; foreign
 * id → 404, R5.2). Matches the frontend's `tasks.api.remove`, which resolves
 * void on a 204.
 */
export async function deleteTaskHandler(
  request: FastifyRequest<{ Params: TaskIdParamsInput }>,
  reply: FastifyReply,
): Promise<void> {
  const { familyId, responsibleUserId } = requireFamilyContext(request);
  await remove({ familyId, responsibleUserId }, request.params.id);
  void reply.code(204).send();
}
