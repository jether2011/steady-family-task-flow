/**
 * Family module Zod schemas — request/response contracts for `/family`.
 *
 * These schemas are attached to the routes via `fastify-type-provider-zod`, so
 * a request that fails them is rejected before any handler runs and the
 * error-handler maps the failure to `422 VALIDATION` (R2.3, R25.2).
 *
 * ### The DTO split, on the wire
 *
 * The frontend sends and receives a SINGLE flat "family" object. The backend
 * splits it across two tables on write and composes it back on read (see the
 * design's "responsible_users / families → single frontend 'family' object"):
 *   - `name`, `avatar_url`      → `families`
 *   - `relationship`            → `responsible_users.relationship`
 *   - `responsible_name`        → `responsible_users.name`
 *
 * {@link FamilyUpdate} is the PATCH body: every field is optional (a partial
 * update) and `.strict()` rejects any unknown key — crucially a client-supplied
 * `family_id`, which must always be derived from the session (R2.4). An invalid
 * `relationship` (outside the enum) fails `z.enum(...)` and surfaces as `422`
 * (R2.3).
 */
import { z } from 'zod';

import { RELATIONSHIP_VALUES } from '../../shared/constants/index.js';

/**
 * `PATCH /api/v1/family` request body.
 *
 * All four fields are optional so the client can patch any subset. `.strict()`
 * forbids unknown keys (notably `family_id`, which is always derived from the
 * session — R2.4). `relationship` is constrained to the enum, so an
 * out-of-range value is a `422 VALIDATION` (R2.3).
 */
export const FamilyUpdate = z
  .object({
    name: z.string().min(1),
    avatar_url: z.string().nullable(),
    relationship: z.enum(RELATIONSHIP_VALUES),
    responsible_name: z.string().nullable(),
  })
  .partial()
  .strict();

/** Parsed, validated `PATCH /family` body. */
export type FamilyUpdateInput = z.infer<typeof FamilyUpdate>;

/**
 * The composed family object returned by `GET`/`PATCH /family`: household
 * `name`/`avatar_url` plus the responsible user's `relationship` and display
 * `responsible_name` (nullable until the profile is filled in).
 */
export const FamilyDTOSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  avatar_url: z.string().nullable(),
  relationship: z.enum(RELATIONSHIP_VALUES).nullable(),
  responsible_name: z.string().nullable(),
});

/** `GET`/`PATCH /family` 200 response envelope: `{ family }`. */
export const FamilyResponse = z.object({
  family: FamilyDTOSchema,
});
