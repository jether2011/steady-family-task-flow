/**
 * Environment configuration — parsed and validated once at startup.
 *
 * Every variable the backend relies on (R29.6) is declared here and validated
 * with Zod. On a missing or malformed required variable the process fails fast
 * with a descriptive message that NAMES the offending key but NEVER prints its
 * value, then exits non-zero (R29.9, R23.5). Nothing else in the codebase reads
 * `process.env` directly; everyone imports the frozen `env` object below.
 */
import { z } from 'zod';

/**
 * Raw schema for the backend's environment surface.
 *
 * - `PORT` is coerced from its string representation to a positive integer.
 * - `NODE_ENV` defaults to `development` so local runs need no extra setup.
 * - The Supabase keys and `CORS_ORIGIN` are required, non-empty strings.
 *   `SUPABASE_URL` must additionally be a valid URL.
 * - `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` are the current Supabase
 *   API keys (`sb_publishable_...` / `sb_secret_...`) that replace the legacy
 *   `anon` / `service_role` keys. They are drop-in replacements for
 *   `createClient(url, key)` and the JWKS-based JWT verification path.
 * - `SUPABASE_JWKS_URL` is OPTIONAL: when unset the backend derives the JWKS
 *   endpoint from `SUPABASE_URL` (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`).
 *   Set it only to point verification at a non-default JWKS location.
 */
const envSchema = z.object({
  MEMBERSHIP_ACCESS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ACCESS_EMAIL_DELIVERY_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.url().startsWith('https://').optional(),
  ),
  ACCESS_EMAIL_DELIVERY_TOKEN: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(1).optional(),
  ),
  PUBLIC_APP_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.url().optional(),
  ),
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  SUPABASE_URL: z.string().min(1).url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  SUPABASE_JWKS_URL: z.string().url().optional(),
  CORS_ORIGIN: z.string().min(1),
});

/** Shape of the validated environment, with `corsOrigins` added. */
export type Env = z.infer<typeof envSchema> & {
  /** `CORS_ORIGIN` split into a trimmed, non-empty allowlist (R29.8). */
  readonly corsOrigins: readonly string[];
};

/**
 * The set of keys we treat as secrets. Their values must never appear in logs
 * or error messages — only the key name is ever surfaced (R23.5, R29.9).
 */
const SECRET_KEYS = new Set([
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
]);

/**
 * Build a human-readable, value-free summary of what failed. Each line names a
 * key and why it was rejected; the actual (possibly secret) value is never
 * included, satisfying R29.9's "does not print secret values" constraint.
 */
function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const key = issue.path.length > 0 ? String(issue.path[0]) : '(root)';
    const reason = SECRET_KEYS.has(key) ? issue.message : `${issue.message}`;
    return `  - ${key}: ${reason}`;
  });
  return `Invalid environment configuration:\n${lines.join('\n')}`;
}

/**
 * Parse the given source (defaults to `process.env`) against the schema.
 *
 * On success returns the frozen, enriched {@link Env}. On failure throws an
 * `Error` whose message names each bad key without exposing any value — callers
 * at startup should log the message and exit non-zero.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(formatIssues(result.error));
  }

  const corsOrigins = result.data.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return Object.freeze({ ...result.data, corsOrigins });
}

/**
 * Validate the environment immediately on import. If anything is missing or
 * malformed, log the descriptive (value-free) message and exit the process
 * with a non-zero code so a misconfigured container never serves traffic
 * (R29.9).
 */
function loadEnv(): Env {
  try {
    return parseEnv();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown configuration error';
    // Intentionally use the raw stream rather than the app logger: the logger
    // itself depends on validated config, and this must run before anything
    // else. The message is value-free by construction.
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

/** The validated, frozen environment used everywhere in the backend. */
export const env: Env = loadEnv();
