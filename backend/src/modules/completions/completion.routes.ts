/**
 * Completion routes — registers `POST /tasks/:id/complete` (task 7.1).
 *
 * This is a plain registration function invoked INSIDE the encapsulated
 * `/api/v1` scope in `app.ts`, so the authentication and context `preHandler`
 * hooks already apply; the path here is relative to the `/api/v1` prefix,
 * resolving to `/api/v1/tasks/:id/complete`.
 *
 * The route carries Zod `params` (uuid `:id`), `body` ({@link TaskComplete},
 * `.strict()`), and a `201` `response` schema ({@link CompleteTaskResponse}),
 * so a non-uuid id, a missing/empty `completedByMemberId`, or any extra body key
 * is rejected as `422 VALIDATION` before the handler runs (R8.5, R23.6). The
 * handler reads identity EXCLUSIVELY from the resolved session context via
 * `requireFamilyContext` (never from the body — R8.3, R23.2) and delegates the
 * ordered ownership/validation checks and the atomic RPC to the service.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { requireFamilyContext } from '../../middleware/context.js';
import type {
  CompleteTaskPayload,
  ReopenTaskPayload,
} from '../../shared/types/index.js';
import { complete, reopen } from './completion.service.js';
import {
  CompleteIdParams,
  CompleteTaskResponse,
  ReopenIdParams,
  ReopenResponse,
  TaskComplete,
  type CompleteIdParamsInput,
  type ReopenIdParamsInput,
  type TaskCompleteInput,
} from './completion.schemas.js';

/**
 * `POST /api/v1/tasks/:id/complete` → `201 CompleteTaskPayload` (R8.1, R8.2).
 *
 * The service runs the ordered checks — task ownership (`404`, R8.8), member
 * family membership (`403`, R8.7), member activeness (`422`, R8.6), already-DONE
 * (`409`, R9.2) — then invokes the atomic `complete_task` RPC. Matches the
 * frontend `tasks.api.complete` envelope exactly.
 */
async function completeTaskHandler(
  request: FastifyRequest<{
    Params: CompleteIdParamsInput;
    Body: TaskCompleteInput;
  }>,
  reply: FastifyReply,
): Promise<CompleteTaskPayload> {
  const { familyId, responsibleUserId } = requireFamilyContext(request);
  const payload = await complete(
    { familyId, responsibleUserId },
    request.params.id,
    request.body,
  );
  void reply.code(201);
  return payload;
}

/**
 * `POST /api/v1/tasks/:id/reopen` → `200 ReopenTaskPayload` (R11.1).
 *
 * Takes no body. The service runs the ordered checks — task ownership (`404`,
 * R11.8), then non-DONE (`422`, R11.4) — then invokes the atomic `reopen_task`
 * RPC and re-reads the task so the response carries the full updated `Task`.
 * Matches the frontend `tasks.api.reopen` envelope exactly.
 */
async function reopenTaskHandler(
  request: FastifyRequest<{ Params: ReopenIdParamsInput }>,
  _reply: FastifyReply,
): Promise<ReopenTaskPayload> {
  const { familyId, responsibleUserId } = requireFamilyContext(request);
  return reopen({ familyId, responsibleUserId }, request.params.id);
}

/**
 * Register the completion routes on the given (already authenticated + context-
 * resolved) Fastify scope. Call from `app.ts` inside the `/api/v1` scope so the
 * paths resolve to `/api/v1/tasks/:id/complete` and `/api/v1/tasks/:id/reopen`.
 */
export function completionRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: 'POST',
    url: '/tasks/:id/complete',
    schema: {
      params: CompleteIdParams,
      body: TaskComplete,
      response: {
        201: CompleteTaskResponse,
      },
    },
    handler: completeTaskHandler,
  });

  typed.route({
    method: 'POST',
    url: '/tasks/:id/reopen',
    schema: {
      params: ReopenIdParams,
      response: {
        200: ReopenResponse,
      },
    },
    handler: reopenTaskHandler,
  });
}
