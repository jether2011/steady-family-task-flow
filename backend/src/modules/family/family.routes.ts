/**
 * Family routes — registers `GET /family` and `PATCH /family`.
 *
 * This is a plain registration function invoked INSIDE the encapsulated
 * `/api/v1` scope in `app.ts`, so the authentication and context `preHandler`
 * hooks already apply; paths here are relative to the `/api/v1` prefix. Each
 * route carries Zod schemas (validated/serialized by `fastify-type-provider-zod`):
 * the PATCH body is {@link FamilyUpdate} (unknown keys and an out-of-range
 * `relationship` are rejected as `422 VALIDATION` before the handler runs —
 * R2.3), and both routes serialize the composed {@link FamilyResponse} `{ family }`.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { getFamilyHandler, updateFamilyHandler } from './family.controller.js';
import { FamilyResponse, FamilyUpdate } from './family.schemas.js';

/**
 * Register the family routes on the given (already authenticated + context-
 * resolved) Fastify scope. Call from `app.ts` inside the `/api/v1` scope so the
 * paths resolve to `GET /api/v1/family` and `PATCH /api/v1/family`.
 */
export function familyRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: 'GET',
    url: '/family',
    schema: {
      response: {
        200: FamilyResponse,
      },
    },
    handler: getFamilyHandler,
  });

  typed.route({
    method: 'PATCH',
    url: '/family',
    schema: {
      body: FamilyUpdate,
      response: {
        200: FamilyResponse,
      },
    },
    handler: updateFamilyHandler,
  });
}
