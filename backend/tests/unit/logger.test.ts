/**
 * Unit tests for the logging redaction policy (task 3.4, R26.1).
 *
 * `buildLoggerOptions` returns a static pino options object whose `redact.paths`
 * encodes the policy that secrets, Bearer tokens, Service_Role_Key material,
 * cookies, and credential body fields must never land in a log line. Because
 * the policy is static, we assert the contents of the `redact.paths` array
 * directly — no live logger or stdout capture is required.
 *
 * `logger.ts` imports `../config/env.js`, whose module body validates
 * `process.env` and calls `process.exit(1)` when required vars are absent. To
 * keep this suite hermetic and green regardless of the ambient environment, we
 * mock `env.js` (the mock is hoisted so the real module body never runs) and
 * pass a fake env straight into `buildLoggerOptions`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/config/env.js';

// Prevent logger.ts's transitive `import { env } from './env.js'` from running
// the real env loader (which would call process.exit on a missing var).
vi.mock('../../src/config/env.js', () => ({
  env: {
    PORT: 8080,
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    CORS_ORIGIN: 'http://localhost:5173',
    corsOrigins: ['http://localhost:5173'],
  },
  parseEnv: vi.fn(),
}));

const { buildLoggerOptions } = await import('../../src/config/logger.js');

/** A minimal fake env — only NODE_ENV is read by buildLoggerOptions. */
function fakeEnv(nodeEnv: Env['NODE_ENV'] = 'test'): Env {
  return {
    PORT: 8080,
    NODE_ENV: nodeEnv,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    CORS_ORIGIN: 'http://localhost:5173',
    corsOrigins: ['http://localhost:5173'],
  } as Env;
}

/** Pull the redact.paths array out of the built options. */
function redactPaths(nodeEnv: Env['NODE_ENV'] = 'test'): string[] {
  const options = buildLoggerOptions(fakeEnv(nodeEnv));
  const redact = options.redact;
  expect(redact).toBeDefined();
  // pino allows redact to be a string[] or an object; this config uses the
  // object form with a censor.
  expect(typeof redact).toBe('object');
  const paths = (redact as { paths: string[]; censor?: unknown }).paths;
  expect(Array.isArray(paths)).toBe(true);
  return paths;
}

describe('buildLoggerOptions — level', () => {
  it('uses info in production and debug elsewhere', () => {
    expect(buildLoggerOptions(fakeEnv('production')).level).toBe('info');
    expect(buildLoggerOptions(fakeEnv('development')).level).toBe('debug');
    expect(buildLoggerOptions(fakeEnv('test')).level).toBe('debug');
  });
});

describe('buildLoggerOptions — redaction policy (R26.1)', () => {
  it('redacts with a censor rather than removing the key', () => {
    const options = buildLoggerOptions(fakeEnv());
    const redact = options.redact as { censor?: unknown };
    expect(redact.censor).toBe('[Redacted]');
  });

  it('covers authorization headers', () => {
    const paths = redactPaths();
    expect(paths).toContain('authorization');
    expect(paths).toContain('req.headers.authorization');
    expect(paths).toContain('*.authorization');
  });

  it('covers *.token (and specific token fields)', () => {
    const paths = redactPaths();
    expect(paths).toContain('*.token');
    expect(paths).toContain('token');
    expect(paths).toContain('access_token');
    expect(paths).toContain('refresh_token');
  });

  it('covers service-role / SUPABASE_SERVICE_ROLE_KEY material', () => {
    const paths = redactPaths();
    expect(paths).toContain('service_role');
    expect(paths).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(paths).toContain('*.service_role');
    expect(paths).toContain('*.SUPABASE_SERVICE_ROLE_KEY');
  });

  it('covers cookie headers', () => {
    const paths = redactPaths();
    expect(paths).toContain('cookie');
    expect(paths).toContain('req.headers.cookie');
    expect(paths).toContain('*.cookie');
  });

  it('covers password / secret credential body fields', () => {
    const paths = redactPaths();
    expect(paths).toContain('password');
    expect(paths).toContain('body.password');
    expect(paths).toContain('*.password');
    expect(paths).toContain('secret');
    expect(paths).toContain('*.secret');
  });

  it('the req serializer scrubs authorization and cookie headers', () => {
    const options = buildLoggerOptions(fakeEnv());
    const serializers = options.serializers as
      | { req?: (r: unknown) => { headers: Record<string, unknown> } }
      | undefined;
    expect(serializers?.req).toBeTypeOf('function');

    const out = serializers!.req!({
      method: 'POST',
      url: '/auth/login',
      headers: {
        authorization: 'Bearer super-secret-jwt',
        cookie: 'session=abc123',
        'content-type': 'application/json',
      },
    });

    expect(out.headers.authorization).toBe('[Redacted]');
    expect(out.headers.cookie).toBe('[Redacted]');
    expect(out.headers['content-type']).toBe('application/json');
    // The real token/session values are gone from the serialized line.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('super-secret-jwt');
    expect(serialized).not.toContain('abc123');
  });
});
