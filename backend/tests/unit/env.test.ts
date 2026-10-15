/**
 * Unit tests for the startup environment parser (task 1.4). These exercise
 * `parseEnv` directly with injected sources so the suite never triggers the
 * module-level `env` load (which calls `process.exit` on bad config). They
 * assert the happy path produces a frozen, enriched env; that a missing
 * required variable throws a descriptive error naming the key; that secret
 * values never leak into error messages; and that malformed PORT / SUPABASE_URL
 * are rejected (R29.9).
 */
import { beforeAll, describe, expect, it } from 'vitest';

// `src/config/env.ts` eagerly runs `loadEnv()` at import time, which calls
// `process.exit(1)` when `process.env` is incomplete. We never want to test
// that module-level `env` directly (task 1.4). To import `parseEnv` without the
// eager load aborting the test process, we first populate `process.env` with a
// complete, valid set of values, then dynamically import the module so the
// eager load succeeds. All assertions still exercise `parseEnv` with injected
// sources — the real `process.env` only exists to let the module import.
let parseEnv: typeof import('../../src/config/env.js').parseEnv;

beforeAll(async () => {
  process.env.PORT = '8080';
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://bootstrap.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'bootstrap-publishable';
  process.env.SUPABASE_SECRET_KEY = 'bootstrap-secret';
  process.env.CORS_ORIGIN = 'https://bootstrap.example.com';

  ({ parseEnv } = await import('../../src/config/env.js'));
});

// A deliberately recognizable fake secret key. If this ever appears in a thrown
// error message the secret-free guarantee (R29.9) has been violated.
const SAMPLE_SECRET_KEY = 'sb_secret_super-secret-value-123456';
const SAMPLE_PUBLISHABLE_KEY = 'sb_publishable_value-abcdef';

/** Build a complete, valid env source, optionally overriding fields. */
function validSource(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const base: Record<string, string> = {
    PORT: '3000',
    NODE_ENV: 'test',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: SAMPLE_PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: SAMPLE_SECRET_KEY,
    CORS_ORIGIN: 'https://a.example.com, https://b.example.com',
  };
  const merged: Record<string, string | undefined> = { ...base, ...overrides };
  // Drop keys explicitly set to undefined so we can simulate "missing" vars.
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) {
      delete merged[key];
    }
  }
  return merged as NodeJS.ProcessEnv;
}

describe('parseEnv — valid source', () => {
  it('returns the enriched env with PORT coerced and corsOrigins split', () => {
    const env = parseEnv(validSource());

    expect(env.PORT).toBe(3000);
    expect(typeof env.PORT).toBe('number');
    expect(env.NODE_ENV).toBe('test');
    expect(env.SUPABASE_URL).toBe('https://project.supabase.co');
    expect(env.corsOrigins).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('returns a frozen object', () => {
    const env = parseEnv(validSource());
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('applies defaults for omitted optional vars (PORT, NODE_ENV)', () => {
    const env = parseEnv(validSource({ PORT: undefined, NODE_ENV: undefined }));
    expect(env.PORT).toBe(8080);
    expect(env.NODE_ENV).toBe('development');
  });
});

describe('parseEnv — missing required var', () => {
  it('throws an error whose message names the missing key', () => {
    const source = validSource({ SUPABASE_URL: undefined });
    expect(() => parseEnv(source)).toThrow(/SUPABASE_URL/);
  });

  it('does not include any secret value in the thrown message', () => {
    // Omit a required var to force failure, but still pass secret values in the
    // source so we can prove they never surface in the message.
    const source = validSource({ SUPABASE_URL: undefined });
    let message = '';
    try {
      parseEnv(source);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toBe('');
    expect(message).toContain('SUPABASE_URL');
    expect(message).not.toContain(SAMPLE_SECRET_KEY);
    expect(message).not.toContain(SAMPLE_PUBLISHABLE_KEY);
  });

  it('names the key when a secret var itself is missing, without a value', () => {
    const source = validSource({ SUPABASE_SECRET_KEY: undefined });
    let message = '';
    try {
      parseEnv(source);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('SUPABASE_SECRET_KEY');
    expect(message).not.toContain(SAMPLE_SECRET_KEY);
  });
});

describe('parseEnv — malformed values', () => {
  it('throws when PORT is not a valid positive integer', () => {
    expect(() => parseEnv(validSource({ PORT: 'not-a-number' }))).toThrow(
      /PORT/,
    );
  });

  it('throws when SUPABASE_URL is not a valid URL', () => {
    expect(() => parseEnv(validSource({ SUPABASE_URL: 'not a url' }))).toThrow(
      /SUPABASE_URL/,
    );
  });
});

describe('billing configuration gates', () => {
  it('leaves purchase disabled with no invented price or member limit', () => {
    const env = parseEnv(validSource());
    expect(env.CHECKOUT_ENABLED).toBe(false);
    expect(env.STRIPE_MODE).toBe('TEST');
    expect(env.STRIPE_PRICE_ID).toBeUndefined();
    expect(env.BILLING_MEMBER_LIMIT).toBeUndefined();
  });
  it('rejects enablement without approved merchant/plan/legal settings', () => {
    expect(() =>
      parseEnv(
        validSource({ BILLING_AVAILABLE: 'true', CHECKOUT_ENABLED: 'true' }),
      ),
    ).toThrow(/missing.*STRIPE_SECRET_KEY/);
  });
  it('does not expose a mismatched live secret', () => {
    const secret = 'sk_live_do-not-log-this';
    let message = '';
    try {
      parseEnv(validSource({ STRIPE_MODE: 'TEST', STRIPE_SECRET_KEY: secret }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('STRIPE_SECRET_KEY');
    expect(message).not.toContain(secret);
  });
  it('rejects unsafe configured return origins and unsupported payment methods', () => {
    expect(() =>
      parseEnv(
        validSource({
          PUBLIC_APP_URL: 'https://app.example.test/redirect?next=evil',
        }),
      ),
    ).toThrow(/PUBLIC_APP_URL/);
    expect(() =>
      parseEnv(
        validSource({ BILLING_PAYMENT_METHODS: 'card,us_bank_account' }),
      ),
    ).toThrow(/BILLING_PAYMENT_METHODS/);
  });
  it('accepts blank optional docker settings without enabling purchase', () => {
    expect(
      parseEnv(
        validSource({
          BILLING_EVENT_RETENTION_DAYS: '',
          STRIPE_SECRET_KEY: '',
          STRIPE_WEBHOOK_SECRET: '',
        }),
      ).CHECKOUT_ENABLED,
    ).toBe(false);
  });
});

describe('approved entitlement policy gates',()=>{
 it('uses no numeric production defaults for grace/outage',()=>{const env=parseEnv(validSource());expect(env.ENTITLEMENT_ENFORCEMENT_ENABLED).toBe(false);expect(env.RENEWAL_GRACE_DAYS).toBeUndefined();expect(env.PROVIDER_OUTAGE_TOLERANCE_HOURS).toBeUndefined();expect(env.ENTITLEMENT_TRIALS_ENABLED).toBe(false);});
 it('rejects enforcement without an approved complete policy',()=>{expect(()=>parseEnv(validSource({ENTITLEMENT_ENFORCEMENT_ENABLED:'true'}))).toThrow(/ENTITLEMENT_POLICY_VERSION/);});
 it('requires an explicit legacy deadline to activate enforcement',()=>{expect(()=>parseEnv(validSource({ENTITLEMENT_ENFORCEMENT_ENABLED:'true',ENTITLEMENT_POLICY_VERSION:'test-v1',ENTITLEMENT_POLICY_APPROVAL:'fixture',RENEWAL_GRACE_DAYS:'7',PROVIDER_OUTAGE_TOLERANCE_HOURS:'24',ENTITLEMENT_EXCEPTION_POLICY:'RESTRICT',STRIPE_ACCOUNT_ID:'acct_fixture',STRIPE_PRICE_ID:'price_fixture',BILLING_MEMBER_LIMIT:'unlimited'}))).toThrow(/LEGACY_ENTITLEMENT_DEADLINE/);});
});
