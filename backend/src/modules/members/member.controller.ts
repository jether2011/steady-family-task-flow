/**
 * Member controller — HTTP glue for the `/api/v1/family/members` routes.
 *
 * Controllers translate between HTTP and the service layer. Identity is read
 * EXCLUSIVELY from the resolved session context via `requireFamilyContext`
 * (which turns a not-yet-bootstrapped family into `404 NOT_FOUND`), never from
 * the request body, query, or headers (R3.2, R23.2). Bodies, query, and path
 * params have already been validated/parsed by each route's Zod schema, so an
 * invalid `member_type` (`422` — R3.5) or a non-uuid `:id` never reaches here;
 * the handlers just forward the typed input to the service.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireFamilyContext } from '../../middleware/context.js';
import type { MemberDTO } from '../../shared/types/index.js';
import {
  create,
  deactivate,
  list,
  update,
} from './member.service.js';
import type {
  MemberCreateInput,
  MemberIdParamsInput,
  MemberListQueryInput,
  MemberUpdateInput,
} from './member.schemas.js';

/** `GET /api/v1/family/members` → `{ members }` (R3.1). */
export async function listMembersHandler(
  request: FastifyRequest<{ Querystring: MemberListQueryInput }>,
  _reply: FastifyReply,
): Promise<{ members: MemberDTO[] }> {
  const { familyId } = requireFamilyContext(request);
  const members = await list({ familyId }, { activeOnly: request.query.active === true });
  return { members };
}

/** `POST /api/v1/family/members` → `201 { member }` (R3.2). */
export async function createMemberHandler(
  request: FastifyRequest<{ Body: MemberCreateInput }>,
  reply: FastifyReply,
): Promise<{ member: MemberDTO }> {
  const { familyId } = requireFamilyContext(request);
  const member = await create({ familyId }, request.body);
  void reply.code(201);
  return { member };
}

/** `PATCH /api/v1/family/members/:id` → `{ member }` (R3.3; foreign id → 404, R3.6). */
export async function updateMemberHandler(
  request: FastifyRequest<{ Params: MemberIdParamsInput; Body: MemberUpdateInput }>,
  _reply: FastifyReply,
): Promise<{ member: MemberDTO }> {
  const { familyId } = requireFamilyContext(request);
  const member = await update({ familyId }, request.params.id, request.body);
  return { member };
}

/**
 * `DELETE /api/v1/family/members/:id` → `{ member }` with `active=false`
 * (soft delete, R3.4; foreign id → 404, R3.6). Returns the updated member
 * rather than `204`, matching the frontend's `members.api.remove`.
 */
export async function deleteMemberHandler(
  request: FastifyRequest<{ Params: MemberIdParamsInput }>,
  _reply: FastifyReply,
): Promise<{ member: MemberDTO }> {
  const { familyId } = requireFamilyContext(request);
  const member = await deactivate({ familyId }, request.params.id);
  return { member };
}
