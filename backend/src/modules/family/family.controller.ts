/**
 * Family controller — HTTP glue for `GET`/`PATCH /api/v1/family`.
 *
 * Controllers translate between HTTP and the service layer. Identity is read
 * EXCLUSIVELY from the resolved session context via `requireFamilyContext`
 * (which turns a not-yet-bootstrapped family into `404 NOT_FOUND`), never from
 * the request body, query, or headers (R2.4, R23.2). The PATCH body has already
 * been validated/parsed by the route's Zod schema, so an invalid `relationship`
 * never reaches here (it is `422` first — R2.3); the handler just forwards the
 * typed patch to the service.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireFamilyContext } from '../../middleware/context.js';
import type { FamilyDTO } from '../../shared/types/index.js';
import { getFamily, updateFamily } from './family.service.js';
import type { FamilyUpdateInput } from './family.schemas.js';

/** `GET /api/v1/family` → `{ family }` (R2.1). */
export async function getFamilyHandler(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<{ family: FamilyDTO }> {
  const { familyId, responsibleUserId } = requireFamilyContext(request);
  const family = await getFamily({ familyId, responsibleUserId });
  return { family };
}

/** `PATCH /api/v1/family` → `{ family }` (R2.2). */
export async function updateFamilyHandler(
  request: FastifyRequest<{ Body: FamilyUpdateInput }>,
  _reply: FastifyReply,
): Promise<{ family: FamilyDTO }> {
  const { familyId, responsibleUserId } = requireFamilyContext(request);
  const family = await updateFamily({ familyId, responsibleUserId }, request.body);
  return { family };
}
