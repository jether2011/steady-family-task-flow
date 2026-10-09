/**
 * Ops probes + OpenAPI docs integration tests (task 12.2).
 *
 * Feature: family-task-board-backend
 * Validates: Requirements 26.2, 26.3, 26.4, 27.1.
 *
 * ----------------------------------------------------------------------------
 * What this file pins down
 * ----------------------------------------------------------------------------
 * These are the deployment-facing, UNAUTHENTICATED surfaces wired in task 12.1
 * (`src/modules/ops/ops.routes.ts` + `src/config/docs.ts`). They are exercised
 * end-to-end through the real `buildApp()` Fastify instance with Supertest, so
 * routing, the Zod type provider, the swagger generator, and the swagger-ui
 * mount are all genuinely in play:
 *
 *   - `GET /api/v1/health` → always `200` while the process is up (R26.2). It
 *     performs no I/O, so the assertion needs no mocking at all.
 *   - `GET /api/v1/ready` → `200` when Supabase is reachable and `503` when it
 *     is not (R26.3/R26.4). Readiness probes Supabase through the service-role
 *     client, so we mock `@supabase/supabase-js`'s `createClient` to drive the
 *     reachability check down BOTH branches — no real database is required.
 *   - `GET /api/docs` → the browsable UI loads (`200`), and the generated
 *     OpenAPI document lists the `/api/v1` routes (R27.1).
 *
 * ----------------------------------------------------------------------------
 * Why no database is needed
 * ----------------------------------------------------------------------------
 * The only I/O on these paths is the readiness reachability probe, which goes
 * through `getServiceRoleClient()` (the `@supabase/supabase-js` client). We mock
 * that module so the `from(...).select(...).limit(...)` chain resolves to a
 * controllable `{ error }` result: `error === null` means "reachable" → 200,
 * a truthy `error` means "unreachable" → 503. A shared mutable flag lets each
 * test flip the branch without rebuilding the app.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';

// `src/config/env.ts` eagerly validates `process.env` at import time and calls
// `process.exit(1)` on a missing required var. `buildApp()` (and the modules it
// pulls in) depend on `env`, so a complete, valid environment MUST exist before
// those modules load. `vi.hoisted` runs ahead of the static imports below. The
// values are placeholders — no network I/O happens at import time (the Supabase
// client is lazily built and, here, fully mocked), so they are never dialed.
vi.hoisted(() => {
  process.env.PORT ??= '8080';
  process.env.NODE_ENV ??= 'test';
  process.env.SUPABASE_URL ??= 'https://project.supabase.co';
  process.env.SUPABASE_ANON_KEY ??= 'anon-test-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-role-test-key';
  process.env.CORS_ORIGIN ??= 'https://app.example.com';
});

/**
 * Shared, mutable reachability control for the readiness probe. The mocked
 * Supabase client reads this on every call, so a test can flip the `/ready`
 * branch (reachable → 200, unreachable → 503) between requests without
 * rebuilding the app or resetting module caches.
 */
const supabaseState: { reachable: boolean } = { reachable: true };

/**
 * Mock `@supabase/supabase-js` so `getServiceRoleClient()` returns a stub whose
 * `from(table).select(cols, opts).limit(n)` chain resolves to the shape the
 * readiness probe awaits: `{ error }`. When `supabaseState.reachable` is true we
 * resolve `{ error: null }` (Supabase answered → ready); otherwise we resolve a
 * PostgREST-style `{ error }` (transport/protocol failure → not ready). No real
 * network call is ever made. The user-scoped `createClient` path is irrelevant
 * to these routes but is covered by the same factory.
 */
vi.mock('@supabase/supabase-js', () => {
  const makeThenable = () => {
    // `.limit(1)` returns an object that is awaited directly in the probe
    // (`probe.then(({ error }) => ...)`), so it must be a thenable resolving to
    // `{ error }`. We also expose chainable `.select`/`.limit` so the exact
    // `from().select().limit()` call shape in ops.routes.ts resolves.
    const thenable = {
      select: () => thenable,
      limit: () => thenable,
      then: (resolve: (value: { error: unknown }) => unknown) =>
        resolve({
          error: supabaseState.reachable
            ? null
            : { message: 'simulated: supabase unreachable', code: 'PGRST000' },
        }),
    };
    return thenable;
  };

  const client = {
    from: () => makeThenable(),
  };

  return {
    createClient: vi.fn(() => client),
  };
});

// Imported AFTER the env is populated and the Supabase module is mocked so the
// app's lazily-built service-role client binds to the stub above.
import { buildApp } from '../../src/app.js';

describe('ops probes + OpenAPI docs (R26.2–R26.4, R27.1)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    // `ready()` runs all plugin registrations (swagger, swagger-ui, ops, the
    // authenticated scope) so `app.server` is a fully-wired HTTP handler
    // Supertest can drive without opening a real listening socket.
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // Default each test to "reachable"; the 503 case opts out explicitly.
  beforeEach(() => {
    supabaseState.reachable = true;
  });

  afterEach(() => {
    supabaseState.reachable = true;
  });

  // ===========================================================================
  // R26.2 — liveness is a successful 200 while the process is up.
  // ===========================================================================
  describe('GET /api/v1/health (R26.2)', () => {
    it('returns 200 with { status: "ok", timestamp }', async () => {
      const res = await request(app.server).get('/api/v1/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.timestamp).toBe('string');
      // The timestamp is a real ISO-8601 instant.
      expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
    });

    it('needs no authentication (no Bearer token sent)', async () => {
      const res = await request(app.server).get('/api/v1/health');
      // A missing Authorization header does NOT yield 401 on this public probe.
      expect(res.status).toBe(200);
    });
  });

  // ===========================================================================
  // R26.3 / R26.4 — readiness reflects Supabase reachability: 200 when
  // reachable, 503 when not. Both branches are driven by the mocked client.
  // ===========================================================================
  describe('GET /api/v1/ready (R26.3, R26.4)', () => {
    it('returns 200 with { status: "ready" } when Supabase is reachable (R26.3)', async () => {
      supabaseState.reachable = true;

      const res = await request(app.server).get('/api/v1/ready');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(typeof res.body.timestamp).toBe('string');
      expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
    });

    it('returns 503 with { status: "unavailable" } when Supabase is unreachable (R26.4)', async () => {
      supabaseState.reachable = false;

      const res = await request(app.server).get('/api/v1/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unavailable');
      expect(typeof res.body.timestamp).toBe('string');
      // The underlying Supabase error is never echoed to the client — only the
      // simple status marker is present.
      expect(JSON.stringify(res.body)).not.toContain('simulated');
      expect(res.body.error).toBeUndefined();
    });

    it('tracks the reachability flag across consecutive requests (both branches)', async () => {
      supabaseState.reachable = true;
      const up = await request(app.server).get('/api/v1/ready');
      expect(up.status).toBe(200);

      supabaseState.reachable = false;
      const down = await request(app.server).get('/api/v1/ready');
      expect(down.status).toBe(503);

      supabaseState.reachable = true;
      const upAgain = await request(app.server).get('/api/v1/ready');
      expect(upAgain.status).toBe(200);
    });

    it('needs no authentication (no Bearer token sent)', async () => {
      supabaseState.reachable = true;
      const res = await request(app.server).get('/api/v1/ready');
      // Public probe: absence of a token must not collapse to 401.
      expect(res.status).not.toBe(401);
      expect(res.status).toBe(200);
    });
  });

  // ===========================================================================
  // R27.1 — the OpenAPI UI loads and the document lists the /api/v1 routes.
  // ===========================================================================
  describe('GET /api/docs + generated OpenAPI document (R27.1)', () => {
    it('serves the browsable UI at /api/docs (200, HTML)', async () => {
      // swagger-ui serves the UI shell under the route prefix. A trailing slash
      // is the canonical UI path; follow redirects so either form loads.
      const res = await request(app.server).get('/api/docs/').redirects(1);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('exposes the generated OpenAPI JSON that lists the /api/v1 routes (R27.1)', async () => {
      // The OpenAPI document is generated in-process by @fastify/swagger. We
      // read it straight off the decorated `app.swagger()` so the assertion is
      // about the document contents, independent of which JSON URL swagger-ui
      // happens to expose.
      const doc = app.swagger() as {
        openapi?: string;
        paths?: Record<string, unknown>;
      };

      expect(doc).toBeTruthy();
      expect(typeof doc.openapi).toBe('string');

      const paths = Object.keys(doc.paths ?? {});
      // The ops probes and at least one authenticated /api/v1 business route
      // must be documented, proving the dynamic generator captured the routes.
      expect(paths).toContain('/api/v1/health');
      expect(paths).toContain('/api/v1/ready');
      expect(paths.some((p) => p.startsWith('/api/v1/'))).toBe(true);
      // Beyond the probes, the family-scoped business routes are present too.
      expect(paths).toContain('/api/v1/family');
    });

    it('serves the OpenAPI JSON over HTTP under the docs prefix', async () => {
      // swagger-ui mounts the spec JSON under the UI prefix. Assert it is
      // reachable and parses as an OpenAPI document listing /api/v1 routes.
      const res = await request(app.server).get('/api/docs/json');

      expect(res.status).toBe(200);
      const paths = Object.keys(res.body.paths ?? {});
      expect(paths).toContain('/api/v1/health');
      expect(paths.some((p) => p.startsWith('/api/v1/'))).toBe(true);
    });
  });
});
