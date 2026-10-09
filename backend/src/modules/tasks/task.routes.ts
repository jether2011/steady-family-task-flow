/**
 * Task routes — registers the task CRUD endpoints (task 6.1).
 *
 * This is a plain registration function invoked INSIDE the encapsulated
 * `/api/v1` scope in `app.ts`, so the authentication and context `preHandler`
 * hooks already apply; paths here are relative to the `/api/v1` prefix. Note
 * the two different path prefixes, matching the design and the frontend
 * `tasks.api`:
 *   - `POST /family/tasks` — create (family-collection path), returns
 *     `201 { task }` (R4.1). The schema's `.strict()` rejects a client-supplied
 *     `status`/`family_id`/`created_by_user_id` as `422` (R4.2); an invalid
 *     `priority`/`points` is `422` (R4.5/R4.6).
 *   - `PATCH /tasks/:id` — update (by-id path), returns `{ task }` (R4.3). A bad
 *     `:id` uuid is `422`; a foreign/missing id resolves to `404` in the
 *     service (R5.2). An invalid `status` is `422` (R4.4).
 *   - `DELETE /tasks/:id` — hard delete (by-id path), returns `204` with no body
 *     (R5.1); a foreign/missing id → `404` (R5.2).
 *
 * ### Extensibility for task 6.2 (listing/filtering + move)
 *
 * This CRUD slice registers only its own three routes. Task 6.2 adds its routes
 * to the SAME module by registering them here (not by touching `app.ts`): add a
 * `GET /family/tasks` (filter) and `POST /tasks/:id/move` route to this
 * function, backed by new handlers in `task.controller.ts` and schemas in
 * `task.schemas.ts`. `app.ts` already calls `taskRoutes(apiV1)` once, so no
 * further wiring is needed there — 6.2 only extends this file and the
 * controller/schemas it already shares.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  carryOverHandler,
  createTaskHandler,
  deleteTaskHandler,
  listTasksHandler,
  moveTaskHandler,
  updateTaskHandler,
} from './task.controller.js';
import {
  CarryOver,
  CarryOverResult,
  TaskCreate,
  TaskFilter,
  TaskIdParams,
  TaskListResponse,
  TaskMove,
  TaskResponse,
  TaskUpdate,
} from './task.schemas.js';

/**
 * Register the task routes on the given (already authenticated + context-
 * resolved) Fastify scope. Call from `app.ts` inside the `/api/v1` scope so the
 * paths resolve to `/api/v1/family/tasks` and `/api/v1/tasks/:id`.
 */
export function taskRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: 'GET',
    url: '/family/tasks',
    schema: {
      querystring: TaskFilter,
      response: {
        200: TaskListResponse,
      },
    },
    handler: listTasksHandler,
  });

  typed.route({
    method: 'POST',
    url: '/tasks/:id/move',
    schema: {
      params: TaskIdParams,
      body: TaskMove,
      response: {
        200: TaskResponse,
      },
    },
    handler: moveTaskHandler,
  });

  typed.route({
    method: 'POST',
    url: '/family/tasks/carry-over',
    schema: {
      body: CarryOver,
      response: {
        200: CarryOverResult,
      },
    },
    handler: carryOverHandler,
  });

  typed.route({
    method: 'POST',
    url: '/family/tasks',
    schema: {
      body: TaskCreate,
      response: {
        201: TaskResponse,
      },
    },
    handler: createTaskHandler,
  });

  typed.route({
    method: 'PATCH',
    url: '/tasks/:id',
    schema: {
      params: TaskIdParams,
      body: TaskUpdate,
      response: {
        200: TaskResponse,
      },
    },
    handler: updateTaskHandler,
  });

  typed.route({
    method: 'DELETE',
    url: '/tasks/:id',
    schema: {
      params: TaskIdParams,
    },
    handler: deleteTaskHandler,
  });
}
