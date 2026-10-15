/**
 * Fastify request typing for the authentication → context pipeline.
 *
 * The authentication hook (`authentication.ts`) and the context resolver
 * (`context.ts`) decorate every `/api/v1` request with two pieces of
 * server-derived state. This module augments Fastify's `FastifyRequest`
 * interface so that state is strongly typed everywhere downstream
 * (controllers, authorization guards, services) without casts.
 *
 *   - `request.authUserId` — the Supabase auth user id taken ONLY from the
 *     verified JWT `sub` claim (R1.7, R23.2). Present after the authentication
 *     hook has run; `undefined` before it (or on public routes).
 *
 *   - `request.ctx` — the resolved request context mapping
 *     `auth.uid()` → `responsible_users.id` → `families.id`. `familyId` is
 *     `null` when the responsible user has not yet bootstrapped a family (only
 *     `GET /me` creates one — task 4.2); routes that require a family assert its
 *     presence and otherwise return `404 NOT_FOUND`.
 *
 * The augmentation lives in its own module (imported for its side effect by the
 * middleware) so the `declare module` block is applied exactly once and the
 * contract has a single documented home.
 */
import 'fastify';
import type { AccessRole } from '../modules/access/access.types.js';

/**
 * Resolved per-request identity/ownership context.
 *
 * Every field is derived server-side from the verified session — never from the
 * request body, query, or headers (R1.7, R23.2). `familyId` is nullable because
 * a verified subject may have no active membership. `/me` only resolves access;
 * tenant creation is a separate lifecycle.
 */
export interface RequestContext {
  readonly authUserId: string;
  readonly appUserId: string;
  readonly ownerResponsibleUserId: string | null;
  readonly membershipId: string | null;
  readonly role: AccessRole | null;
  readonly memberId: string | null;
  readonly accessVersion: number | null;
  readonly accessState: 'READY' | 'NO_ACCESS' | 'REVOKED';
  /** Supabase auth user id (the verified JWT `sub`). */
  readonly userId: string;
  /** Legacy owner `responsible_users.id` for the resolved family; never the acting manager identity. */
  readonly responsibleUserId: string | null;
  /** `families.id` for the active membership, or `null` when access is absent. */
  readonly familyId: string | null;
}

/**
 * Verified identity claims carried by the Supabase session JWT, beyond `sub`.
 *
 * These are read ONLY from the cryptographically-verified token (see
 * `authentication.ts`), but editable profile claims are not authorization evidence. Never source them from
 * the request body/query/headers (R1.7, R23.2). Authorization uses only the verified subject and provider-admin confirmed
 * mailbox. These optional claims remain for compatibility and presentation.
 */
export interface AuthClaims {
  /** JWT email claim; do not use it to claim memberships. */
  readonly email?: string;
  /** Best-effort display name from Google-backed `user_metadata`. */
  readonly name?: string;
  /** Best-effort avatar URL from `user_metadata`. */
  readonly avatarUrl?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The verified Supabase auth user id (JWT `sub`). Set by the authentication
     * hook; `undefined` on public routes or before the hook runs.
     */
    authUserId?: string;
    /**
     * Verified non-`sub` identity claims (email/name/avatar) from the session
     * JWT. Set by the authentication hook; used by `/me` to seed the
     * responsible-user profile on first login. `undefined` before the hook runs.
     */
    authClaims?: AuthClaims;
    /**
     * The resolved request context. Set by the context resolver hook;
     * `undefined` on routes that do not run context resolution.
     */
    ctx?: RequestContext;
  }
}
