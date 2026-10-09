/**
 * Template controller — HTTP glue for the task-template routes (CRUD slice,
 * task 9.1).
 *
 * Controllers translate between HTTP and the service layer. Identity is read
 * EXCLUSIVELY from the resolved session context via `requireFamilyContext`
 * (which turns a not-yet-bootstrapped family into `404 NOT_FOUND`), never from
 * the request body, query, or headers (R23.2). Bodies and path params have
 * already been validated/parsed by each route's Zod schema, so an invalid
 * `recurrence_type`/`priority`/`points`, a CUSTOM template missing a valid
 * `recurrence_config.days` (`422` — R12.5), a client-supplied
 * `family_id`/`active` on create (rejected by `.strict()` — R23.2), or a
 * non-uuid `:id` never reaches here; the handlers just forward the typed input
 * to the service.
 *
 * Task 9.2 (recurring generation) adds its `generateHandler` here.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireFamilyContext } from '../../middleware/context.js';
import type { TemplateDTO } from '../../shared/types/index.js';
import { create, deactivate, generate, list, update } from './template.service.js';
import type {
  GenerateInput,
  TemplateCreateInput,
  TemplateIdParamsInput,
  TemplateUpdateInput,
} from './template.schemas.js';

/**
 * `GET /api/v1/family/task-templates` → `{ templates }` (R12.1). Family-scoped.
 * Matches the frontend `templates.api.list` envelope.
 */
export async function listTemplatesHandler(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<{ templates: TemplateDTO[] }> {
  const { familyId } = requireFamilyContext(request);
  const templates = await list({ familyId });
  return { templates };
}

/**
 * `POST /api/v1/family/task-templates` → `201 { template }` (R12.2). A CUSTOM
 * template with a missing/invalid `recurrence_config.days` → `422` (R12.5).
 * Matches the frontend `templates.api.create` envelope.
 */
export async function createTemplateHandler(
  request: FastifyRequest<{ Body: TemplateCreateInput }>,
  reply: FastifyReply,
): Promise<{ template: TemplateDTO }> {
  const { familyId } = requireFamilyContext(request);
  const template = await create({ familyId }, request.body);
  void reply.code(201);
  return { template };
}

/**
 * `PATCH /api/v1/task-templates/:id` → `{ template }` (R12.3; foreign/missing
 * id → 404). Matches the frontend `templates.api.update` envelope.
 */
export async function updateTemplateHandler(
  request: FastifyRequest<{ Params: TemplateIdParamsInput; Body: TemplateUpdateInput }>,
  _reply: FastifyReply,
): Promise<{ template: TemplateDTO }> {
  const { familyId } = requireFamilyContext(request);
  const template = await update({ familyId }, request.params.id, request.body);
  return { template };
}

/**
 * `DELETE /api/v1/task-templates/:id` → `204` with no body (deactivate, R12.4;
 * foreign/missing id → 404). Matches the frontend's `templates.api.remove`,
 * which resolves void on a 204.
 */
export async function deleteTemplateHandler(
  request: FastifyRequest<{ Params: TemplateIdParamsInput }>,
  reply: FastifyReply,
): Promise<void> {
  const { familyId } = requireFamilyContext(request);
  await deactivate({ familyId }, request.params.id);
  void reply.code(204).send();
}

/**
 * `POST /api/v1/family/task-templates/generate` → `{ weekStart, created }`
 * (R13.1).
 *
 * Identity (`familyId` + `responsibleUserId`) is read from the resolved session
 * context, never the body (R4.2, R23.2). The `weekStart` body was already
 * validated as a UTC Monday by the `Generate` schema, so a
 * missing/malformed/non-Monday value is rejected as `422 VALIDATION` before
 * this handler runs and no task is created (R13.9). Returns the full
 * `{ weekStart, created }` result, matching the frontend `templates.api.generate`
 * envelope.
 */
export async function generateHandler(
  request: FastifyRequest<{ Body: GenerateInput }>,
  _reply: FastifyReply,
): Promise<{ weekStart: string; created: number }> {
  const { familyId, responsibleUserId } = requireFamilyContext(request);
  return generate({ familyId, responsibleUserId }, request.body.weekStart);
}
