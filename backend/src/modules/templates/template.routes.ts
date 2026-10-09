/**
 * Template routes — registers the task-template CRUD endpoints (task 9.1).
 *
 * This is a plain registration function invoked INSIDE the encapsulated
 * `/api/v1` scope in `app.ts`, so the authentication and context `preHandler`
 * hooks already apply; paths here are relative to the `/api/v1` prefix. Note
 * the two different path prefixes, matching the design and the frontend
 * `templates.api`:
 *   - `GET /family/task-templates` — list (family-collection path), returns
 *     `{ templates }` (R12.1).
 *   - `POST /family/task-templates` — create (family-collection path), returns
 *     `201 { template }` (R12.2). The schema's `.strict()` rejects a
 *     client-supplied `family_id`/`active`; a CUSTOM template without a valid
 *     `recurrence_config.days` → `422` (R12.5).
 *   - `PATCH /task-templates/:id` — update (by-id path), returns `{ template }`
 *     (R12.3). A bad `:id` uuid is `422`; a foreign/missing id resolves to
 *     `404` in the service.
 *   - `DELETE /task-templates/:id` — deactivate (by-id path), returns `204`
 *     with no body (R12.4); a foreign/missing id → `404`.
 *
 * ### Extensibility for task 9.2 (recurring generation)
 *
 * This CRUD slice registers only its own four routes. Task 9.2 adds the
 * recurring-generation endpoint to the SAME module by registering it here (not
 * by touching `app.ts`): add a `POST /family/task-templates/generate` route to
 * this function, backed by a `generateHandler` in `template.controller.ts`, a
 * `Generate` body schema (`{ weekStart }`) + response schema in
 * `template.schemas.ts`, and a generation service that uses the shared UTC date
 * utils to materialize tasks idempotently. `app.ts` already calls
 * `templateRoutes(apiV1)` once, so no further wiring is needed there — 9.2 only
 * extends this file and the controller/schemas/service it already shares.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  createTemplateHandler,
  deleteTemplateHandler,
  generateHandler,
  listTemplatesHandler,
  updateTemplateHandler,
} from './template.controller.js';
import {
  Generate,
  GenerateResult,
  TemplateCreate,
  TemplateIdParams,
  TemplateListResponse,
  TemplateResponse,
  TemplateUpdate,
} from './template.schemas.js';

/**
 * Register the template routes on the given (already authenticated + context-
 * resolved) Fastify scope. Call from `app.ts` inside the `/api/v1` scope so the
 * paths resolve to `/api/v1/family/task-templates` and
 * `/api/v1/task-templates/:id`.
 */
export function templateRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: 'GET',
    url: '/family/task-templates',
    schema: {
      response: {
        200: TemplateListResponse,
      },
    },
    handler: listTemplatesHandler,
  });

  typed.route({
    method: 'POST',
    url: '/family/task-templates',
    schema: {
      body: TemplateCreate,
      response: {
        201: TemplateResponse,
      },
    },
    handler: createTemplateHandler,
  });

  typed.route({
    method: 'PATCH',
    url: '/task-templates/:id',
    schema: {
      params: TemplateIdParams,
      body: TemplateUpdate,
      response: {
        200: TemplateResponse,
      },
    },
    handler: updateTemplateHandler,
  });

  typed.route({
    method: 'DELETE',
    url: '/task-templates/:id',
    schema: {
      params: TemplateIdParams,
    },
    handler: deleteTemplateHandler,
  });

  // Recurring generation (task 9.2): idempotently materialize tasks for the
  // target (Monday) week. The `Generate` body schema rejects a
  // missing/malformed/non-Monday `weekStart` as `422` before the handler runs
  // (R13.9); the response is `{ weekStart, created }` (R13.1).
  typed.route({
    method: 'POST',
    url: '/family/task-templates/generate',
    schema: {
      body: Generate,
      response: {
        200: GenerateResult,
      },
    },
    handler: generateHandler,
  });
}
