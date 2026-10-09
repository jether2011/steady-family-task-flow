/**
 * Authentication middleware — verifies the Supabase-issued Bearer JWT.
 *
 * Every `/api/v1` request (except the public `/health`, `/ready`, `/api/docs`
 * probes) must carry `Authorization: Bearer <jwt>`. This hook:
 *
 *   1. Reads the `Authorization` header and extracts the Bearer token.
 *   2. Verifies the token's signature against the Supabase project JWKS, checks
 *      the issuer (`${SUPABASE_URL}/auth/v1`) and expiry.
 *   3. Trusts ONLY the verified `sub` claim as the auth user id — identity is
 *      never read from the body, query, or any other header (R1.7, R23.2).
 *   4. On any missing/malformed/invalid/expired token throws {@link Unauthorized},
 *      which the Error_Contract handler (task 3.2) maps to `401 UNAUTHORIZED`
 *      (R1.2, R1.3).
 *
 * ### JWKS verification approach
 *
 * Supabase now signs project JWTs asymmetrically and publishes the public keys
 * at `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`. We verify with `jose`'s
 * `createRemoteJWKSet` + `jwtVerify`, which fetches and caches the JWKS and
 * transparently refreshes it on key rotation (`kid` miss). This keeps the
 * backend stateless: no shared secret is distributed, and rotated keys are
 * picked up automatically.
 *
 * ### Legacy shared-secret (HS256) caveat
 *
 * Older Supabase projects (or projects that have not migrated to asymmetric
 * keys) still sign with the legacy symmetric HS256 **JWT secret**. Those tokens
 * cannot be verified via the JWKS endpoint — the JWKS set would be empty or
 * lack a usable key, and verification here will fail (→ 401). If a deployment
 * targets such a project, an alternative verify path is required: verify with
 * `jose.jwtVerify(token, new TextEncoder().encode(SUPABASE_JWT_SECRET))` using
 * the project's JWT secret (a new env var, e.g. `SUPABASE_JWT_SECRET`), instead
 * of (or as a fallback to) the JWKS path. This backend intentionally implements
 * the JWKS path only, per the design ("verify JWT (JWKS)"); the legacy path is
 * documented here so a future migration task can add it without rediscovery.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import { env } from '../config/env.js';
import { Unauthorized } from '../shared/errors/index.js';
import type { AuthClaims } from './types.js';

// Import for its side effect: augments `FastifyRequest` with `authUserId`/`ctx`.
import './types.js';

/**
 * The Supabase Auth issuer. Supabase signs project session tokens with
 * `iss = ${SUPABASE_URL}/auth/v1`; we require an exact match so a token minted
 * for a different project/issuer is rejected.
 */
const ISSUER = `${env.SUPABASE_URL}/auth/v1`;

/** The project JWKS endpoint publishing the asymmetric signing public keys. */
const JWKS_URL = new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);

/**
 * Remote JWKS, created once and shared across requests. `jose` caches the keys
 * in-process and re-fetches on a `kid` miss, so key rotation is handled without
 * restarting the service. Lazily initialized so importing this module never
 * performs network I/O at load time (and tests can inject their own verifier).
 */
let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (remoteJwks === undefined) {
    remoteJwks = createRemoteJWKSet(JWKS_URL);
  }
  return remoteJwks;
}

/**
 * Extract the Bearer token from an `Authorization` header value.
 *
 * Accepts exactly `Bearer <token>` (case-insensitive scheme, single space).
 * Returns the trimmed token, or `undefined` when the header is absent or does
 * not match the Bearer scheme.
 */
export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (typeof authorization !== 'string') {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (match === null) {
    return undefined;
  }
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

/**
 * The verifier function type. Isolated so tests can substitute a deterministic
 * verifier via {@link setJwtVerifier} without hitting the network.
 */
export type JwtVerifier = (token: string) => Promise<JWTPayload>;

/**
 * Default verifier: validate signature against the project JWKS and enforce the
 * issuer. `jose` enforces `exp`/`nbf` automatically, so an expired token throws
 * (→ 401, R1.3). Only standard-claim checks run here; no claim is trusted for
 * identity except `sub`, read by the hook below.
 */
async function defaultVerify(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: ISSUER,
  });
  return payload;
}

/** Active verifier (overridable in tests). */
let verifier: JwtVerifier = defaultVerify;

/**
 * Override the JWT verifier (test seam). Pass no argument to restore the default
 * JWKS-backed verifier.
 */
export function setJwtVerifier(next?: JwtVerifier): void {
  verifier = next ?? defaultVerify;
}

/**
 * Verify a request's Bearer token and return the auth user id (`sub`).
 *
 * Throws {@link Unauthorized} on a missing/malformed/invalid/expired token or a
 * token lacking a usable `sub` claim. The returned value is the ONLY identity
 * the rest of the pipeline may trust (R1.7, R23.2).
 */
export async function authenticateRequest(request: FastifyRequest): Promise<string> {
  const token = extractBearerToken(request.headers.authorization);
  if (token === undefined) {
    throw new Unauthorized();
  }

  let payload: JWTPayload;
  try {
    payload = await verifier(token);
  } catch {
    // Any verification failure (bad signature, wrong issuer, expired, malformed,
    // unknown kid) collapses to a single 401 — we never disclose *why* the token
    // was rejected.
    throw new Unauthorized();
  }

  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Unauthorized();
  }
  return sub;
}

/** Read a trimmed non-empty string from an unknown claim value, else undefined. */
function stringClaim(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Extract the verified non-`sub` identity claims (email, display name, avatar)
 * from a Supabase session payload.
 *
 * Supabase surfaces the OAuth profile under a top-level `email` claim and a
 * nested `user_metadata` object (`name`/`full_name`, `avatar_url`/`picture`
 * for Google). Everything here comes from the cryptographically-verified token,
 * so it is trusted identity used only to seed the `responsible_users` row on
 * first-login bootstrap. Any missing field is simply omitted; `exactOptional
 * PropertyTypes` means we never set a key to `undefined`.
 */
export function extractAuthClaims(payload: JWTPayload): AuthClaims {
  const claims: { email?: string; name?: string; avatarUrl?: string } = {};

  const email = stringClaim(payload.email);
  if (email !== undefined) {
    claims.email = email;
  }

  const metadata = payload.user_metadata;
  if (typeof metadata === 'object' && metadata !== null) {
    const meta = metadata as Record<string, unknown>;
    const name = stringClaim(meta.full_name) ?? stringClaim(meta.name);
    if (name !== undefined) {
      claims.name = name;
    }
    const avatarUrl = stringClaim(meta.avatar_url) ?? stringClaim(meta.picture);
    if (avatarUrl !== undefined) {
      claims.avatarUrl = avatarUrl;
    }
  }

  return claims;
}

/**
 * Verify a request's Bearer token and return both the auth user id (`sub`) and
 * the verified identity claims used for first-login bootstrap.
 *
 * Shares the single verification path with {@link authenticateRequest}: any
 * failure collapses to {@link Unauthorized} and only `sub` is required.
 */
export async function authenticateRequestWithClaims(
  request: FastifyRequest,
): Promise<{ authUserId: string; claims: AuthClaims }> {
  const token = extractBearerToken(request.headers.authorization);
  if (token === undefined) {
    throw new Unauthorized();
  }

  let payload: JWTPayload;
  try {
    payload = await verifier(token);
  } catch {
    throw new Unauthorized();
  }

  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Unauthorized();
  }

  return { authUserId: sub, claims: extractAuthClaims(payload) };
}

/**
 * Fastify `preHandler` hook that enforces authentication.
 *
 * Verifies the Bearer JWT and attaches the verified `sub` to
 * `request.authUserId` plus the verified identity claims to
 * `request.authClaims`. Register this on the `/api/v1` scope (skipping public
 * probes) so it runs before context resolution and route handlers.
 */
export async function authenticationHook(request: FastifyRequest): Promise<void> {
  const { authUserId, claims } = await authenticateRequestWithClaims(request);
  request.authUserId = authUserId;
  request.authClaims = claims;
}

/**
 * Register {@link authenticationHook} as a `preHandler` on an encapsulated
 * Fastify scope. Mount domain modules that require authentication inside this
 * scope (e.g. `app.register(authenticatedScope)` then register routes), or call
 * {@link authenticationHook} directly as a route `preHandler`.
 */
export function registerAuthentication(app: FastifyInstance): void {
  app.addHook('preHandler', authenticationHook);
}
