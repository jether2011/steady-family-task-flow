/**
 * Context resolver middleware — maps the verified auth user to its family.
 *
 * After authentication (`authentication.ts`) has set `request.authUserId`, this
 * hook resolves the ownership chain once per request:
 *
 *     auth.uid()  →  responsible_users.id  →  families.id
 *
 * and attaches it as `request.ctx = { userId, responsibleUserId, familyId }`
 * (the contract documented in `types.ts`). Downstream controllers read identity
 * from `request.ctx` and NEVER from the request body/query/headers (R1.7,
 * R23.2).
 *
 * ### Resolve, don't create
 *
 * This resolver only reads what already exists. It does **not** create the
 * `responsible_users` row or the `families` row — bootstrap happens exclusively
 * in `GET /me` (task 4.2), guarded by `UNIQUE(responsible_user_id)` so at most
 * one family exists (R1.6). When no responsible user and/or no family exists
 * yet, the corresponding field is `null`:
 *
 *   - `GET /me` opts out of the "family required" behavior: it reads whatever
 *     context exists (possibly all-null) WITHOUT throwing, then creates the
 *     missing rows itself and returns them.
 *   - Every other family-scoped route asserts a family is present via
 *     {@link requireFamilyContext}; a `null` `familyId` becomes `404 NOT_FOUND`.
 *
 * ### Which Supabase client
 *
 * Resolution uses the **service-role client** for two reasons: it is a pure
 * read of the caller's own two rows (keyed by the verified `auth_user_id`, so no
 * cross-family leakage is possible), and it avoids an RLS bootstrap paradox —
 * `current_family_id()` depends on these very rows, so a user-scoped read of a
 * not-yet-existing family would be awkward. The service role never trusts
 * client input here; it filters strictly by the verified `request.authUserId`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { getServiceRoleClient } from '../config/supabase.js';
import { NotFound, Unauthorized } from '../shared/errors/index.js';
import type { RequestContext } from './types.js';

// Import for its side effect: augments `FastifyRequest` with `authUserId`/`ctx`.
import './types.js';

/**
 * Resolve the request context for a verified auth user id.
 *
 * Reads `responsible_users` by `auth_user_id`, then `families` by
 * `responsible_user_id`. Missing rows yield `null` fields rather than errors so
 * `/me` can bootstrap. Never throws for "not found" — only for an unexpected
 * database failure.
 *
 * @param authUserId The verified Supabase `sub` (see `authentication.ts`).
 */
export async function resolveContext(authUserId: string): Promise<RequestContext> {
  const db = getServiceRoleClient();

  // responsible_users.id for this auth user (at most one — UNIQUE(auth_user_id)).
  const responsible = await db
    .from('responsible_users')
    .select('id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  if (responsible.error) {
    throw responsible.error;
  }

  const responsibleUserId =
    responsible.data && typeof responsible.data.id === 'string'
      ? responsible.data.id
      : null;

  if (responsibleUserId === null) {
    // No responsible user yet → no family either; /me will create both.
    return { userId: authUserId, responsibleUserId: null, familyId: null };
  }

  // families.id owned by this responsible user (at most one — UNIQUE).
  const family = await db
    .from('families')
    .select('id')
    .eq('responsible_user_id', responsibleUserId)
    .maybeSingle();

  if (family.error) {
    throw family.error;
  }

  const familyId =
    family.data && typeof family.data.id === 'string' ? family.data.id : null;

  return { userId: authUserId, responsibleUserId, familyId };
}

/**
 * Fastify `preHandler` hook that attaches `request.ctx`.
 *
 * Must run after the authentication hook. If `authUserId` is missing (hook
 * misordered or not applied), throws {@link Unauthorized} as a safety net —
 * context must never resolve for an unauthenticated request.
 */
export async function contextHook(request: FastifyRequest): Promise<void> {
  const authUserId = request.authUserId;
  if (authUserId === undefined) {
    throw new Unauthorized();
  }
  request.ctx = await resolveContext(authUserId);
}

/**
 * Assert that the request has a fully-resolved family context and return it
 * narrowed so `familyId`/`responsibleUserId` are non-null.
 *
 * Family-scoped routes (everything except `/me`) call this to turn a
 * not-yet-bootstrapped context into `404 NOT_FOUND` (R23.3 — a missing family is
 * indistinguishable from any other not-found). `/me` deliberately does NOT call
 * this; it uses `request.ctx` directly and bootstraps the missing rows.
 *
 * @throws Unauthorized if the context hook has not run.
 * @throws NotFound if the responsible user or family has not been created yet.
 */
export function requireFamilyContext(request: FastifyRequest): {
  userId: string;
  responsibleUserId: string;
  familyId: string;
} {
  const ctx = request.ctx;
  if (ctx === undefined) {
    throw new Unauthorized();
  }
  if (ctx.responsibleUserId === null || ctx.familyId === null) {
    throw new NotFound();
  }
  return {
    userId: ctx.userId,
    responsibleUserId: ctx.responsibleUserId,
    familyId: ctx.familyId,
  };
}

/**
 * Register {@link contextHook} as a `preHandler` on a Fastify scope. Register it
 * AFTER the authentication hook on the same scope so `authUserId` is set first.
 */
export function registerContext(app: FastifyInstance): void {
  app.addHook('preHandler', contextHook);
}
