/**
 * Unit tests for the authentication middleware + `/me` bootstrap controller
 * (task 4.3).
 *
 * These assert the contract that keeps identity trustworthy:
 *
 *   - `extractBearerToken` parses `Bearer <token>` case-insensitively and
 *     rejects missing/malformed headers.
 *   - `authenticateRequest` / `authenticateRequestWithClaims` verify the token
 *     through the injectable {@link setJwtVerifier} seam: a valid payload with a
 *     usable `sub` yields that `sub`; a verifier that throws (bad/expired/
 *     invalid) collapses to `401 UNAUTHORIZED` (R1.2, R1.3); a payload lacking a
 *     usable `sub` → Unauthorized; a missing `Authorization` header →
 *     Unauthorized (R1.1).
 *   - Identity is read ONLY from the verified `sub` — never from the body/query/
 *     headers (R1.7): a request carrying a *different* user id in its body/query
 *     still resolves to the token's `sub`.
 *   - `extractAuthClaims` lifts email + display name + avatar from the verified
 *     payload (top-level `email`, nested `user_metadata.full_name`/`name` and
 *     `avatar_url`/`picture`) and omits absent fields.
 *   - The `/me` controller reads `request.authUserId` (not any body) and returns
 *     the service payload, and throws Unauthorized when the hook never ran
 *     (R1.4/R1.5 create-once-return-same is covered thoroughly by the Property-1
 *     test, task 4.4 — here we only check the controller wiring).
 *
 * No DB is touched: the verifier seam provides deterministic payloads and the
 * auth service's `bootstrapMe` is mocked, so the suite is pure and fast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JWTPayload } from 'jose';

// `src/config/env.ts` eagerly validates `process.env` at import time and calls
// `process.exit(1)` when a required var is missing. The authentication module
// (via `env`) and the auth controller (via the Supabase client factory) both
// pull in `env`, so we must populate a complete, valid environment BEFORE those
// modules load. `vi.hoisted` runs ahead of the hoisted static imports below,
// guaranteeing the vars are present when `env.ts` first executes. No network
// I/O happens at import time (JWKS and Supabase clients are lazily built), so
// these placeholder values are never dialed.
vi.hoisted(() => {
  process.env.PORT ??= '8080';
  process.env.NODE_ENV ??= 'test';
  process.env.SUPABASE_URL ??= 'https://project.supabase.co';
  process.env.SUPABASE_ANON_KEY ??= 'anon-test-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-role-test-key';
  process.env.CORS_ORIGIN ??= 'https://app.example.com';
});

// Mock the auth service so the controller test never reaches the DB. The mock
// is declared before importing the controller so the controller binds to it.
vi.mock('../../src/modules/auth/auth.service.js', () => ({
  bootstrapMe: vi.fn(),
}));

import {
  authenticateRequest,
  authenticateRequestWithClaims,
  extractAuthClaims,
  extractBearerToken,
  setJwtVerifier,
  type JwtVerifier,
} from '../../src/middleware/authentication.js';
import { getMe } from '../../src/modules/auth/auth.controller.js';
import { bootstrapMe } from '../../src/modules/auth/auth.service.js';
import { Unauthorized } from '../../src/shared/errors/index.js';

const mockedBootstrapMe = vi.mocked(bootstrapMe);

/**
 * Build a minimal `FastifyRequest` for the authentication helpers. Only the
 * fields the code reads are populated; `body`/`query` default to decoy identity
 * so the R1.7 "never read identity from the request" guarantee can be asserted.
 */
function makeRequest(options: {
  authorization?: string;
  body?: unknown;
  query?: unknown;
  authUserId?: string;
  authClaims?: unknown;
}): FastifyRequest {
  return {
    headers:
      options.authorization === undefined
        ? {}
        : { authorization: options.authorization },
    body: options.body,
    query: options.query,
    authUserId: options.authUserId,
    authClaims: options.authClaims,
  } as unknown as FastifyRequest;
}

/** A verifier that always resolves the given payload. */
function verifierReturning(payload: JWTPayload): JwtVerifier {
  return () => Promise.resolve(payload);
}

/** A verifier that always rejects (bad signature / expired / malformed). */
function verifierThrowing(): JwtVerifier {
  return () => Promise.reject(new Error('token verification failed'));
}

describe('extractBearerToken', () => {
  it('parses a well-formed "Bearer <token>" header', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('is case-insensitive on the scheme', () => {
    expect(extractBearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('BEARER abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('BeArEr abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('tolerates surrounding whitespace and multiple spaces after the scheme', () => {
    expect(extractBearerToken('  Bearer    abc.def.ghi  ')).toBe('abc.def.ghi');
  });

  it('returns undefined for an absent header', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  it('returns undefined for a non-Bearer scheme', () => {
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeUndefined();
    expect(extractBearerToken('Token abc.def.ghi')).toBeUndefined();
  });

  it('returns undefined when the scheme is present but the token is missing', () => {
    expect(extractBearerToken('Bearer')).toBeUndefined();
    expect(extractBearerToken('Bearer   ')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(extractBearerToken('')).toBeUndefined();
  });
});

describe('authenticateRequest — via the injected verifier seam', () => {
  // Always restore the real JWKS-backed verifier so no later test is affected.
  afterEach(() => {
    setJwtVerifier();
  });

  it('returns the verified sub for a valid payload', async () => {
    setJwtVerifier(verifierReturning({ sub: 'user-123' }));
    const sub = await authenticateRequest(
      makeRequest({ authorization: 'Bearer valid.token' }),
    );
    expect(sub).toBe('user-123');
  });

  it('throws Unauthorized (401) when the verifier throws — bad/expired/invalid token (R1.2, R1.3)', async () => {
    setJwtVerifier(verifierThrowing());
    const request = makeRequest({ authorization: 'Bearer expired.token' });
    await expect(authenticateRequest(request)).rejects.toBeInstanceOf(
      Unauthorized,
    );
    await expect(authenticateRequest(request)).rejects.toMatchObject({
      http: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('throws Unauthorized when the payload lacks a usable sub', async () => {
    setJwtVerifier(verifierReturning({ email: 'a@b.co' } as JWTPayload));
    await expect(
      authenticateRequest(makeRequest({ authorization: 'Bearer no.sub' })),
    ).rejects.toBeInstanceOf(Unauthorized);
  });

  it('throws Unauthorized when sub is an empty string', async () => {
    setJwtVerifier(verifierReturning({ sub: '' }));
    await expect(
      authenticateRequest(makeRequest({ authorization: 'Bearer empty.sub' })),
    ).rejects.toBeInstanceOf(Unauthorized);
  });

  it('throws Unauthorized (401) when the Authorization header is missing (R1.1)', async () => {
    // The verifier should never even be consulted when there is no token.
    const verifier = vi.fn(verifierReturning({ sub: 'user-123' }));
    setJwtVerifier(verifier);
    await expect(authenticateRequest(makeRequest({}))).rejects.toBeInstanceOf(
      Unauthorized,
    );
    expect(verifier).not.toHaveBeenCalled();
  });

  it('reads identity ONLY from the token sub, never from the body/query (R1.7)', async () => {
    // The request carries a conflicting user id in both body and query. The
    // resolved identity must be the token's sub, proving neither is consulted.
    setJwtVerifier(verifierReturning({ sub: 'token-sub-id' }));
    const request = makeRequest({
      authorization: 'Bearer trusted.token',
      body: { authUserId: 'attacker-body-id', user_id: 'attacker-body-id' },
      query: { authUserId: 'attacker-query-id' },
    });
    const sub = await authenticateRequest(request);
    expect(sub).toBe('token-sub-id');
    expect(sub).not.toBe('attacker-body-id');
    expect(sub).not.toBe('attacker-query-id');
  });
});

describe('authenticateRequestWithClaims — sub + verified identity claims', () => {
  afterEach(() => {
    setJwtVerifier();
  });

  it('returns the sub and the extracted claims for a valid payload', async () => {
    setJwtVerifier(
      verifierReturning({
        sub: 'user-abc',
        email: 'parent@example.com',
        user_metadata: { full_name: 'Pat Parent', avatar_url: 'https://img/p.png' },
      } as JWTPayload),
    );
    const result = await authenticateRequestWithClaims(
      makeRequest({ authorization: 'Bearer valid.token' }),
    );
    expect(result).toEqual({
      authUserId: 'user-abc',
      claims: {
        email: 'parent@example.com',
        name: 'Pat Parent',
        avatarUrl: 'https://img/p.png',
      },
    });
  });

  it('throws Unauthorized when the verifier throws', async () => {
    setJwtVerifier(verifierThrowing());
    await expect(
      authenticateRequestWithClaims(
        makeRequest({ authorization: 'Bearer bad.token' }),
      ),
    ).rejects.toBeInstanceOf(Unauthorized);
  });

  it('throws Unauthorized when the Authorization header is missing', async () => {
    await expect(
      authenticateRequestWithClaims(makeRequest({})),
    ).rejects.toBeInstanceOf(Unauthorized);
  });

  it('throws Unauthorized when the payload lacks a usable sub', async () => {
    setJwtVerifier(verifierReturning({ email: 'x@y.co' } as JWTPayload));
    await expect(
      authenticateRequestWithClaims(
        makeRequest({ authorization: 'Bearer no.sub' }),
      ),
    ).rejects.toBeInstanceOf(Unauthorized);
  });
});

describe('extractAuthClaims', () => {
  it('reads top-level email and user_metadata full_name + avatar_url', () => {
    const claims = extractAuthClaims({
      sub: 'u1',
      email: 'me@example.com',
      user_metadata: {
        full_name: 'Full Name',
        avatar_url: 'https://img/a.png',
      },
    } as JWTPayload);
    expect(claims).toEqual({
      email: 'me@example.com',
      name: 'Full Name',
      avatarUrl: 'https://img/a.png',
    });
  });

  it('prefers full_name over name and avatar_url over picture', () => {
    const claims = extractAuthClaims({
      user_metadata: {
        full_name: 'Preferred Full',
        name: 'Fallback Name',
        avatar_url: 'https://img/preferred.png',
        picture: 'https://img/fallback.png',
      },
    } as JWTPayload);
    expect(claims.name).toBe('Preferred Full');
    expect(claims.avatarUrl).toBe('https://img/preferred.png');
  });

  it('falls back to name and picture when full_name/avatar_url are absent', () => {
    const claims = extractAuthClaims({
      user_metadata: {
        name: 'Just Name',
        picture: 'https://img/pic.png',
      },
    } as JWTPayload);
    expect(claims.name).toBe('Just Name');
    expect(claims.avatarUrl).toBe('https://img/pic.png');
  });

  it('omits fields the payload does not carry (no undefined keys set)', () => {
    const claims = extractAuthClaims({ sub: 'only-sub' } as JWTPayload);
    expect(claims).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(claims, 'email')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(claims, 'name')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(claims, 'avatarUrl')).toBe(false);
  });

  it('omits blank/whitespace-only claim values', () => {
    const claims = extractAuthClaims({
      email: '   ',
      user_metadata: { full_name: '', name: '  ', avatar_url: '' },
    } as JWTPayload);
    expect(claims).toEqual({});
  });

  it('ignores a non-object user_metadata while still reading top-level email', () => {
    const claims = extractAuthClaims({
      email: 'top@example.com',
      user_metadata: 'not-an-object',
    } as unknown as JWTPayload);
    expect(claims).toEqual({ email: 'top@example.com' });
  });
});

describe('getMe controller — reads request.authUserId, not the body (R1.7)', () => {
  beforeEach(() => {
    mockedBootstrapMe.mockReset();
  });

  it('forwards the verified authUserId + claims to the service and returns its payload', async () => {
    const servicePayload = {
      family: {
        id: 'fam-1',
        name: 'My Family',
        avatar_url: null,
        relationship: null,
        responsible_name: null,
      },
      responsibleUser: { id: 'ru-1', email: null, avatar_url: null },
    };
    mockedBootstrapMe.mockResolvedValue(servicePayload as never);

    const request = makeRequest({
      authUserId: 'token-sub-id',
      authClaims: { email: 'me@example.com' },
      // Decoy identity in the body must be ignored.
      body: { authUserId: 'attacker-body-id' },
    });

    const result = await getMe(request, {} as unknown as FastifyReply);

    expect(result).toBe(servicePayload);
    expect(mockedBootstrapMe).toHaveBeenCalledTimes(1);
    expect(mockedBootstrapMe).toHaveBeenCalledWith('token-sub-id', {
      email: 'me@example.com',
    });
    // Confirm the body's decoy id was never passed through.
    const [passedId] = mockedBootstrapMe.mock.calls[0];
    expect(passedId).not.toBe('attacker-body-id');
  });

  it('defaults claims to an empty object when the hook attached none', async () => {
    mockedBootstrapMe.mockResolvedValue({} as never);
    await getMe(
      makeRequest({ authUserId: 'token-sub-id' }),
      {} as unknown as FastifyReply,
    );
    expect(mockedBootstrapMe).toHaveBeenCalledWith('token-sub-id', {});
  });

  it('throws Unauthorized when request.authUserId is undefined (hook never ran)', async () => {
    await expect(
      getMe(makeRequest({}), {} as unknown as FastifyReply),
    ).rejects.toBeInstanceOf(Unauthorized);
    expect(mockedBootstrapMe).not.toHaveBeenCalled();
  });
});
