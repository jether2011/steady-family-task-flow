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
const optionalBillingString = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().min(1).optional(),
);
const envSchema = z.object({
  ENTITLEMENT_ENFORCEMENT_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ENTITLEMENT_TRIALS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ENTITLEMENT_POLICY_VERSION: optionalBillingString,
  ENTITLEMENT_POLICY_APPROVAL: optionalBillingString,
  RENEWAL_GRACE_DAYS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(0).max(90).optional(),
  ),
  PROVIDER_OUTAGE_TOLERANCE_HOURS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(0).max(168).optional(),
  ),
  LEGACY_ENTITLEMENT_DEADLINE: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.iso.datetime({ offset: true }).optional(),
  ),
  ENTITLEMENT_EXCEPTION_POLICY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.literal('RESTRICT').optional(),
  ),

  CHECKOUT_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  STRIPE_MODE: z.enum(['TEST', 'LIVE']).default('TEST'),
  STRIPE_SECRET_KEY: optionalBillingString,
  STRIPE_WEBHOOK_SECRET: optionalBillingString,
  STRIPE_ACCOUNT_ID: optionalBillingString,
  STRIPE_MERCHANT_COUNTRY: optionalBillingString,
  STRIPE_PRICE_ID: optionalBillingString,
  STRIPE_PORTAL_CONFIGURATION_ID: optionalBillingString,
  BILLING_PLAN_TITLE: optionalBillingString,
  BILLING_PLAN_FEATURES: optionalBillingString,
  BILLING_MEMBER_LIMIT: optionalBillingString,
  BILLING_CURRENCY: optionalBillingString,
  BILLING_TAX_BEHAVIOR: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['inclusive', 'exclusive']).optional(),
  ),
  BILLING_AUTOMATIC_TAX: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['true', 'false']).optional(),
  ),
  BILLING_PAYMENT_METHODS: optionalBillingString,
  BILLING_TERMS_URL: optionalBillingString,
  BILLING_PRIVACY_URL: optionalBillingString,
  BILLING_POLICY_URL: optionalBillingString,
  BILLING_TAX_DISCLOSURE: optionalBillingString,
  BILLING_APPROVAL_REFERENCE: optionalBillingString,
  BILLING_EVENT_RETENTION_DAYS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(1).max(365).optional(),
  ),
  BILLING_MAX_RETRIES: z.coerce.number().int().min(1).max(30).default(10),

  SELF_SERVICE_SIGNUP_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  BILLING_AVAILABLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MEMBER_VIEWS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
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
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
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

  const billing = result.data;
  if (
    billing.STRIPE_SECRET_KEY &&
    !billing.STRIPE_SECRET_KEY.startsWith(
      billing.STRIPE_MODE === 'LIVE' ? 'sk_live_' : 'sk_test_',
    )
  )
    throw new Error(
      'Invalid environment configuration: STRIPE_SECRET_KEY does not match STRIPE_MODE',
    );
  if (billing.CHECKOUT_ENABLED && !billing.BILLING_AVAILABLE)
    throw new Error(
      'Invalid environment configuration: CHECKOUT_ENABLED requires BILLING_AVAILABLE',
    );
  if (billing.CHECKOUT_ENABLED) {
    const required = [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_ACCOUNT_ID',
      'STRIPE_MERCHANT_COUNTRY',
      'STRIPE_PRICE_ID',
      'STRIPE_PORTAL_CONFIGURATION_ID',
      'PUBLIC_APP_URL',
      'BILLING_PLAN_TITLE',
      'BILLING_PLAN_FEATURES',
      'BILLING_MEMBER_LIMIT',
      'BILLING_CURRENCY',
      'BILLING_TAX_BEHAVIOR',
      'BILLING_AUTOMATIC_TAX',
      'BILLING_PAYMENT_METHODS',
      'BILLING_TERMS_URL',
      'BILLING_PRIVACY_URL',
      'BILLING_POLICY_URL',
      'BILLING_TAX_DISCLOSURE',
      'BILLING_APPROVAL_REFERENCE',
      'BILLING_EVENT_RETENTION_DAYS',
    ] as const;
    const missing = required.filter((k) => billing[k] === undefined);
    if (missing.length)
      throw new Error(
        'Invalid environment configuration: missing ' + missing.join(', '),
      );
  }
  for (const key of [
    'PUBLIC_APP_URL',
    'BILLING_TERMS_URL',
    'BILLING_PRIVACY_URL',
    'BILLING_POLICY_URL',
  ] as const) {
    const value = billing[key];
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('Invalid environment configuration: ' + key);
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(
          billing.NODE_ENV !== 'production' &&
          ['localhost', '127.0.0.1'].includes(url.hostname) &&
          url.protocol === 'http:'
        )) ||
      (key === 'PUBLIC_APP_URL' && url.pathname !== '/')
    )
      throw new Error(
        'Invalid environment configuration: ' +
          key +
          ' must be an approved HTTPS URL',
      );
  }
  if (
    billing.BILLING_MEMBER_LIMIT &&
    billing.BILLING_MEMBER_LIMIT !== 'unlimited' &&
    (!/^[1-9][0-9]*$/.test(billing.BILLING_MEMBER_LIMIT) ||
      !Number.isSafeInteger(Number(billing.BILLING_MEMBER_LIMIT)))
  )
    throw new Error('Invalid environment configuration: BILLING_MEMBER_LIMIT');
  if (
    billing.BILLING_PAYMENT_METHODS &&
    billing.BILLING_PAYMENT_METHODS !== 'card'
  )
    throw new Error(
      'Invalid environment configuration: BILLING_PAYMENT_METHODS currently supports approved card-only automatic collection',
    );
  if (
    billing.CHECKOUT_ENABLED ||
    billing.ENTITLEMENT_ENFORCEMENT_ENABLED ||
    billing.ENTITLEMENT_TRIALS_ENABLED ||
    billing.ENTITLEMENT_POLICY_VERSION
  ) {
    const keys = [
      'ENTITLEMENT_POLICY_VERSION',
      'ENTITLEMENT_POLICY_APPROVAL',
      'RENEWAL_GRACE_DAYS',
      'PROVIDER_OUTAGE_TOLERANCE_HOURS',
      'ENTITLEMENT_EXCEPTION_POLICY',
      'STRIPE_ACCOUNT_ID',
      'STRIPE_PRICE_ID',
      'BILLING_MEMBER_LIMIT',
    ] as const;
    const missing = keys.filter((k) => billing[k] === undefined);
    if (missing.length)
      throw new Error(
        'Invalid environment configuration: missing ' + missing.join(', '),
      );
    if (
      billing.ENTITLEMENT_ENFORCEMENT_ENABLED &&
      !billing.LEGACY_ENTITLEMENT_DEADLINE
    )
      throw new Error(
        'Invalid environment configuration: LEGACY_ENTITLEMENT_DEADLINE is required for enforcement',
      );
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
