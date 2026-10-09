/**
 * Auth / bootstrap routes — registers `GET /me`.
 *
 * This is a Fastify plugin mounted INSIDE the encapsulated `/api/v1` scope in
 * `app.ts`, so the authentication and context `preHandler` hooks already apply
 * to it; the paths here are relative to the `/api/v1` prefix. The route carries
 * a Zod response schema (validated/serialized by `fastify-type-provider-zod`)
 * describing the composed {@link MePayload} shape documented in the design's
 * "/me" row and the responsible_users/families DTO split.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { RELATIONSHIP_VALUES } from '../../shared/constants/index.js';
import { getMe } from './auth.controller.js';

/**
 * Composed family object: `families.name`/`avatar_url` plus the responsible
 * user's `relationship`/`responsible_name` (nullable until the user fills in
 * their profile).
 */
const FamilyDTOSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  avatar_url: z.string().nullable(),
  relationship: z.enum(RELATIONSHIP_VALUES).nullable(),
  responsible_name: z.string().nullable(),
});

/** The authenticated adult surfaced by `/me`. */
const ResponsibleUserDTOSchema = z.object({
  id: z.string().uuid(),
  email: z.string().nullable(),
  avatar_url: z.string().nullable(),
});

/** `GET /me` 200 response envelope. */
const MePayloadSchema = z.object({
  family: FamilyDTOSchema,
  responsibleUser: ResponsibleUserDTOSchema,
});

/**
 * Register the auth/bootstrap routes on the given (already authenticated)
 * Fastify scope. Call from `app.ts` inside the `/api/v1` scope so `/me`
 * resolves to `GET /api/v1/me`.
 */
export function authRoutes(app: FastifyInstance): void {
  app.withTypeProvider<ZodTypeProvider>().route({
    method: 'GET',
    url: '/me',
    schema: {
      response: {
        200: MePayloadSchema,
      },
    },
    handler: getMe,
  });
}
