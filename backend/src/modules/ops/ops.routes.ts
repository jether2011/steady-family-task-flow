/**
 * Ops routes — liveness (`/health`) and readiness (`/ready`) probes.
 *
 * These are the deployment-facing probes an orchestrator (Docker/K8s/host)
 * hits to decide whether the process is alive and whether it should receive
 * traffic. They are intentionally **unauthenticated**: a probe never carries a
 * Bearer token, so this plugin is registered OUTSIDE the authenticated
 * `/api/v1` scope in `app.ts` while still being mounted at the `/api/v1`
 * prefix. The result is `GET /api/v1/health` and `GET /api/v1/ready` reachable
 * without any auth (R26.2–R26.4).
 *
 *   - `GET /api/v1/health` → always `200 { status: 'ok', timestamp }` while the
 *     process is up. It performs no I/O; a successful response is itself the
 *     liveness signal (R26.2).
 *   - `GET /api/v1/ready` → `200 { status: 'ready', timestamp }` when Supabase
 *     is reachable, else `503 { status: 'unavailable', timestamp }` (R26.3,
 *     R26.4). Readiness makes one cheap, bounded Supabase call via the
 *     service-role client and never leaks the underlying error.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { getServiceRoleClient } from '../../config/supabase.js';

/** Max time we allow the Supabase reachability probe to run before giving up. */
const READINESS_TIMEOUT_MS = 2000;

/** `GET /api/v1/health` response: liveness is a successful 200 (R26.2). */
const HealthResponse = z.object({
  status: z.literal('ok'),
  timestamp: z.string(),
});

/** `GET /api/v1/ready` 200 body — Supabase reachable (R26.3). */
const ReadyResponse = z.object({
  status: z.literal('ready'),
  timestamp: z.string(),
});

/** `GET /api/v1/ready` 503 body — Supabase unreachable (R26.4). */
const NotReadyResponse = z.object({
  status: z.literal('unavailable'),
  timestamp: z.string(),
});

/**
 * Probe Supabase reachability with a cheap, bounded request.
 *
 * We issue a HEAD-style `count` against a known table (`families`) through the
 * service-role client — the smallest round trip that still exercises the
 * network path and PostgREST. We only care *whether* the call reaches Supabase
 * and returns a protocol-level response, not about any rows, so an RLS/empty
 * result still counts as "reachable". The call is raced against a short timeout
 * so a hung connection can't stall the readiness probe. Any thrown/rejected
 * error (DNS, TCP, TLS, timeout, 5xx) means "not reachable" → caller returns
 * 503. The error itself is never surfaced to the client (R25.3-style hygiene).
 *
 * @returns `true` when Supabase answered within the timeout, `false` otherwise.
 */
async function isSupabaseReachable(): Promise<boolean> {
  try {
    const client = getServiceRoleClient();

    // A head+count query returns no rows and is about as cheap as a round trip
    // to PostgREST gets while still proving the backend can talk to Supabase.
    const probe = client
      .from('families')
      .select('*', { head: true, count: 'exact' })
      .limit(1);

    // Race the probe against a hard timeout so a stalled socket can't hang the
    // readiness endpoint. The timeout branch resolves to a non-OK marker.
    const timeout = new Promise<{ reachable: false }>((resolve) => {
      setTimeout(() => resolve({ reachable: false }), READINESS_TIMEOUT_MS);
    });

    const result = await Promise.race([
      probe.then(({ error }) => ({
        // A transport/protocol-level failure (unreachable, auth, 5xx) carries a
        // PostgREST error; anything else (including an empty/RLS result) means
        // we successfully reached Supabase.
        reachable: error === null || error === undefined,
      })),
      timeout,
    ]);

    return result.reachable;
  } catch {
    // Any thrown error (network/DNS/TLS, client construction) → not reachable.
    return false;
  }
}

/**
 * Register the ops probes on the given scope. Called from `app.ts` with a
 * `/api/v1` prefix and WITHOUT the authentication/context hooks, so both routes
 * are public. Paths here are relative to that prefix.
 */
export function opsRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // Liveness: no I/O, always 200 while the event loop can serve the request.
  typed.route({
    method: 'GET',
    url: '/health',
    schema: {
      tags: ['Ops'],
      summary: 'Liveness probe',
      description:
        'Returns 200 while the process is running. Performs no I/O and requires no authentication (R26.2).',
      response: {
        200: HealthResponse,
      },
    },
    handler: async () => ({
      status: 'ok' as const,
      timestamp: new Date().toISOString(),
    }),
  });

  // Readiness: 200 only when Supabase is reachable, else 503 (R26.3/R26.4).
  typed.route({
    method: 'GET',
    url: '/ready',
    schema: {
      tags: ['Ops'],
      summary: 'Readiness probe',
      description:
        'Returns 200 when the backend can reach Supabase, else 503. Requires no authentication (R26.3, R26.4).',
      response: {
        200: ReadyResponse,
        503: NotReadyResponse,
      },
    },
    handler: async (_request, reply) => {
      const timestamp = new Date().toISOString();
      if (await isSupabaseReachable()) {
        return { status: 'ready' as const, timestamp };
      }
      // Not reachable → signal "do not route traffic here yet" (R26.4). The
      // body is a simple status; we never echo the underlying error.
      return reply
        .status(503)
        .send({ status: 'unavailable' as const, timestamp });
    },
  });
}
