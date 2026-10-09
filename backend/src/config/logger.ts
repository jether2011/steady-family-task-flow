/**
 * Structured logging configuration (pino) for the Fastify backend.
 *
 * This module exports a single, reusable pino options object consumed as
 * Fastify's `logger` option (see `app.ts`). Fastify already emits one
 * structured log line per request and per response; this configuration layers
 * on a `redact` policy so that secrets, tokens, Service_Role_Key values,
 * cookies, and credential-bearing request/response bodies NEVER land in a log
 * line (R26.1).
 *
 * Design reference — "Error Handling / Components and Interfaces → Logging":
 *   > A `redact` list removes `authorization`, `*.token`, `*.service_role*`,
 *   > cookies, and request bodies on auth routes so secrets never land in logs.
 *
 * We intentionally keep this a plain options object (not a constructed pino
 * instance) so Fastify owns the logger lifecycle and request/response
 * serializers, while we only contribute the redaction policy and level.
 */
import type { LoggerOptions } from 'pino';

import { env, type Env } from './env.js';

/**
 * Redaction paths applied to every log line.
 *
 * pino matches these against the serialized log object. We cover the field in
 * several shapes because a secret can surface under different parents:
 *   - at the top level of the log object (`authorization`, `token`, …),
 *   - nested under Fastify's `req`/`res` serializers (`req.headers.*`),
 *   - and under a logged `headers`/`body`/`payload` bag when a handler
 *     explicitly logs one.
 *
 * The `*` wildcard matches exactly one path segment; `[*]` matches array
 * elements. Paths are case-sensitive, so header names are listed in the
 * lowercased form pino/Fastify normalize them to, plus the canonical casing
 * that may appear if a raw header bag is logged.
 */
const REDACT_PATHS: readonly string[] = [
  // --- Authorization headers (Bearer JWTs) in every place they can appear ---
  'authorization',
  'Authorization',
  'headers.authorization',
  'headers.Authorization',
  'req.headers.authorization',
  'req.headers.Authorization',
  'request.headers.authorization',
  'res.headers.authorization',
  'response.headers.authorization',
  '*.authorization',

  // --- Cookies (may carry session/auth material) ---
  'cookie',
  'cookies',
  'headers.cookie',
  'req.headers.cookie',
  'request.headers.cookie',
  'res.headers["set-cookie"]',
  'response.headers["set-cookie"]',
  'headers["set-cookie"]',
  '*.cookie',

  // --- Any `*.token` field (access_token, refresh_token, id_token, token) ---
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  '*.id_token',
  '*.*.token',

  // --- Service-role key / anon key material (`*.service_role*` and env names) ---
  'service_role',
  'service_role_key',
  'serviceRoleKey',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  '*.service_role',
  '*.service_role_key',
  '*.serviceRoleKey',
  '*.SUPABASE_SERVICE_ROLE_KEY',
  '*.SUPABASE_ANON_KEY',

  // --- Credential-bearing body fields on auth/credential routes ---
  'password',
  'apiKey',
  'api_key',
  'secret',
  'body.password',
  'body.access_token',
  'body.refresh_token',
  'body.token',
  'body.secret',
  'payload.password',
  'payload.access_token',
  'payload.refresh_token',
  'payload.token',
  '*.password',
  '*.apiKey',
  '*.api_key',
  '*.secret',
];

/**
 * Build the pino logger options for a given validated environment.
 *
 * - `level` is `info` in production and `debug` elsewhere, matching the prior
 *   inline configuration in `app.ts`.
 * - `redact` applies {@link REDACT_PATHS} and keeps the matched keys with a
 *   `[Redacted]` censor rather than removing them, so operators can still see
 *   that a field was present (and scrubbed) without exposing its value.
 * - `serializers` wrap Fastify's default request serializer to additionally
 *   guarantee the `authorization` and `cookie` headers are stripped, so even a
 *   future serializer change cannot leak the Bearer token in the per-request
 *   log line.
 *
 * Output stays JSON (one line per request/error); we deliberately do NOT attach
 * `pino-pretty` here so production/CI logs remain machine-parseable.
 */
export function buildLoggerOptions(targetEnv: Env): LoggerOptions {
  return {
    level: targetEnv.NODE_ENV === 'production' ? 'info' : 'debug',
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[Redacted]',
    },
    serializers: {
      /**
       * Request serializer: emit the useful request fields but scrub the
       * sensitive headers before they are ever written. `redact` is a second
       * line of defense; this ensures the header value is gone even if a path
       * no longer matches after a Fastify serializer change.
       */
      req(request: {
        method?: string;
        url?: string;
        headers?: Record<string, unknown>;
        [key: string]: unknown;
      }) {
        const rawHeaders = request.headers ?? {};
        const headers: Record<string, unknown> = { ...rawHeaders };
        if ('authorization' in headers) headers.authorization = '[Redacted]';
        if ('Authorization' in headers) headers.Authorization = '[Redacted]';
        if ('cookie' in headers) headers.cookie = '[Redacted]';

        return {
          method: request.method,
          url: request.url,
          headers,
        };
      },
    },
  };
}

/**
 * Default logger options derived from the process environment. `app.ts` passes
 * this directly as Fastify's `logger` option so redaction is always applied.
 */
export const loggerOptions: LoggerOptions = buildLoggerOptions(env);
