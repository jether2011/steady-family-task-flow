/**
 * Auth / bootstrap controller — HTTP glue for `GET /api/v1/me`.
 *
 * Controllers translate between HTTP and the service layer and read identity
 * exclusively from the server-derived `request.authUserId` / `request.authClaims`
 * set by the authentication hook — NEVER from the request body, query, or
 * headers (R1.7, R23.2). `GET /me` has no request body, so there is nothing to
 * parse; the handler simply forwards the verified identity to the service.
 *
 * Unlike every other family-scoped route, `/me` does NOT call
 * `requireFamilyContext`: it is the one route allowed to run with a not-yet-
 * bootstrapped context and create the missing rows itself (task 4.2).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

import { Unauthorized } from '../../shared/errors/index.js';
import type { MePayload } from '../../shared/types/index.js';
import { bootstrapMe } from './auth.service.js';

/**
 * Handle `GET /api/v1/me`.
 *
 * Bootstraps the caller's responsible-user + family on first login, else returns
 * the existing ones, as the composed {@link MePayload}. Throws
 * {@link Unauthorized} if the authentication hook did not run (defensive — the
 * route is always mounted behind it).
 */
export async function getMe(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<MePayload> {
  const authUserId = request.authUserId;
  if (authUserId === undefined) {
    throw new Unauthorized();
  }
  return bootstrapMe(authUserId, request.authClaims ?? {});
}
