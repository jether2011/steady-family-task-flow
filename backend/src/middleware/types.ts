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

/**
 * Resolved per-request identity/ownership context.
 *
 * Every field is derived server-side from the verified session — never from the
 * request body, query, or headers (R1.7, R23.2). `familyId` is nullable because
 * a freshly-authenticated responsible user may not have a family yet; the `/me`
 * bootstrap route is the only place a family is created.
 */
export interface RequestContext {
  /** Supabase auth user id (the verified JWT `sub`). */
  readonly userId: string;
  /** `responsible_users.id` for this auth user, or `null` if none exists yet. */
  readonly responsibleUserId: string | null;
  /** `families.id` owned by the responsible user, or `null` if none exists yet. */
  readonly familyId: string | null;
}

/**
 * Verified identity claims carried by the Supabase session JWT, beyond `sub`.
 *
 * These are read ONLY from the cryptographically-verified token (see
 * `authentication.ts`), so they are trustworthy identity — never sourced from
 * the request body/query/headers (R1.7, R23.2). They exist to seed the
 * `responsible_users` row on first-login bootstrap (`GET /me`, task 4.2) with a
 * sensible email/display name/avatar; every field is optional because a token
 * may omit any of them.
 */
export interface AuthClaims {
  /** Verified `email` claim, when present. */
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
