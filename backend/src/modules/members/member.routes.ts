/**
 * Member routes — registers the `/family/members` CRUD + soft-delete endpoints.
 *
 * This is a plain registration function invoked INSIDE the encapsulated
 * `/api/v1` scope in `app.ts`, so the authentication and context `preHandler`
 * hooks already apply; paths here are relative to the `/api/v1` prefix. Each
 * route carries Zod schemas (validated/serialized by `fastify-type-provider-zod`):
 *   - `GET /family/members` validates the `?active` filter and serializes
 *     {@link MembersResponse} `{ members }` (R3.1).
 *   - `POST /family/members` validates {@link MemberCreate} (unknown keys and an
 *     out-of-range `member_type` are rejected as `422 VALIDATION` — R3.5) and
 *     returns `201 { member }` (R3.2).
 *   - `PATCH`/`DELETE /family/members/:id` validate the `:id` path param as a
 *     uuid (a bad uuid is `422`) and serialize {@link MemberResponse}
 *     `{ member }`; a foreign/missing id resolves to `404` in the service (R3.6).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  createMemberHandler,
  deleteMemberHandler,
  listMembersHandler,
  updateMemberHandler,
} from './member.controller.js';
import {
  MemberCreate,
  MemberIdParams,
  MemberListQuery,
  MemberResponse,
  MemberUpdate,
  MembersResponse,
} from './member.schemas.js';

/**
 * Register the member routes on the given (already authenticated + context-
 * resolved) Fastify scope. Call from `app.ts` inside the `/api/v1` scope so the
 * paths resolve to `/api/v1/family/members` and `/api/v1/family/members/:id`.
 */
export function memberRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: 'GET',
    url: '/family/members',
    schema: {
      querystring: MemberListQuery,
      response: {
        200: MembersResponse,
      },
    },
    handler: listMembersHandler,
  });

  typed.route({
    method: 'POST',
    url: '/family/members',
    schema: {
      body: MemberCreate,
      response: {
        201: MemberResponse,
      },
    },
    handler: createMemberHandler,
  });

  typed.route({
    method: 'PATCH',
    url: '/family/members/:id',
    schema: {
      params: MemberIdParams,
      body: MemberUpdate,
      response: {
        200: MemberResponse,
      },
    },
    handler: updateMemberHandler,
  });

  typed.route({
    method: 'DELETE',
    url: '/family/members/:id',
    schema: {
      params: MemberIdParams,
      response: {
        200: MemberResponse,
      },
    },
    handler: deleteMemberHandler,
  });
}
