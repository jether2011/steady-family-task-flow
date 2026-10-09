/**
 * Members module Zod schemas — request/response contracts for `/family/members`.
 *
 * These schemas are attached to the routes via `fastify-type-provider-zod`, so
 * a request that fails them is rejected before any handler runs and the
 * error-handler maps the failure to `422 VALIDATION` (R3.5, R25.2). In
 * particular a `member_type` outside {PARENT, CHILD, DEPENDENT} fails
 * `z.enum(...)` and surfaces as `422` (R3.5), and any unknown key (notably a
 * client-supplied `family_id`, which must always be derived from the session)
 * is rejected by `.strict()` (R23.2).
 */
import { z } from 'zod';

import { MEMBER_TYPE_VALUES } from '../../shared/constants/index.js';

/**
 * `POST /api/v1/family/members` request body.
 *
 * `name` is required and non-empty; `member_type` is constrained to the enum so
 * an out-of-range value is a `422 VALIDATION` (R3.5). `avatar_url`, `color`,
 * and `birth_year` are optional. `.strict()` forbids unknown keys — crucially a
 * client-supplied `family_id` or `active`, both of which are server-derived
 * (R3.2, R23.2).
 */
export const MemberCreate = z
  .object({
    name: z.string().min(1),
    member_type: z.enum(MEMBER_TYPE_VALUES),
    avatar_url: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    birth_year: z.number().int().nullable().optional(),
  })
  .strict();

/** Parsed, validated `POST /family/members` body. */
export type MemberCreateInput = z.infer<typeof MemberCreate>;

/**
 * `PATCH /api/v1/family/members/:id` request body.
 *
 * Every field is optional (a partial update) and `active` may be toggled
 * directly (R3.3). `.strict()` forbids unknown keys (notably `family_id`, which
 * is always derived from the session — R23.2). An invalid `member_type`
 * (outside the enum) fails `z.enum(...)` and surfaces as `422` (R3.5).
 */
export const MemberUpdate = z
  .object({
    name: z.string().min(1),
    member_type: z.enum(MEMBER_TYPE_VALUES),
    avatar_url: z.string().nullable(),
    color: z.string().nullable(),
    birth_year: z.number().int().nullable(),
    active: z.boolean(),
  })
  .partial()
  .strict();

/** Parsed, validated `PATCH /family/members/:id` body. */
export type MemberUpdateInput = z.infer<typeof MemberUpdate>;

/**
 * `GET /api/v1/family/members` query string.
 *
 * The frontend `members.api.list(activeOnly)` sends `?active=true` to filter to
 * the active roster, or omits it for all members. Coerced from the string query
 * value and optional.
 */
export const MemberListQuery = z
  .object({
    active: z.coerce.boolean().optional(),
  })
  .strict();

/** Parsed, validated `GET /family/members` query. */
export type MemberListQueryInput = z.infer<typeof MemberListQuery>;

/**
 * `:id` path parameter for the by-id routes. A non-uuid value is rejected as
 * `422 VALIDATION` before the handler runs.
 */
export const MemberIdParams = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

/** Parsed, validated `:id` path params. */
export type MemberIdParamsInput = z.infer<typeof MemberIdParams>;

/** A family member record returned by the members routes. */
export const MemberDTOSchema = z.object({
  id: z.string().uuid(),
  family_id: z.string().uuid(),
  name: z.string(),
  member_type: z.enum(MEMBER_TYPE_VALUES),
  avatar_url: z.string().nullable(),
  color: z.string().nullable(),
  birth_year: z.number().int().nullable(),
  active: z.boolean(),
});

/** `GET /family/members` 200 response envelope: `{ members: Member[] }`. */
export const MembersResponse = z.object({
  members: z.array(MemberDTOSchema),
});

/**
 * Single-member response envelope: `{ member }`. Used for `POST` (201),
 * `PATCH`, and the soft-delete `DELETE` (which returns the member with
 * `active=false`).
 */
export const MemberResponse = z.object({
  member: MemberDTOSchema,
});
