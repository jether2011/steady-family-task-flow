import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import {
  applySchema,
  connect,
  hasDatabase,
  seedFamily,
  type PgClient,
} from './db-harness.js';
let db: PgClient,
  seed: Awaited<ReturnType<typeof seedFamily>>,
  other: typeof seed;
const files = [
  '007_membership_access.sql',
  '008_member_views.sql',
  '009_tenant_onboarding.sql',
  '010_stripe_billing.sql',
];
const sql = await Promise.all(
  files.map((f) =>
    readFile(
      new URL('../../src/supabase/migrations/' + f, import.meta.url),
      'utf8',
    ),
  ),
);
const params = {
  price: 'price_test',
  origin: 'https://app.example.test',
  automaticTax: false,
  termsUrl: 'https://app.example.test/terms',
  privacyUrl: 'https://app.example.test/privacy',
  policyUrl: 'https://app.example.test/policy',
  approval: 'test-fixture',
};
async function reserve(
  client = db,
  key = randomUUID(),
  hash = 'hash',
  subject = seed.authUserId,
  family = seed.familyId,
) {
  return (
    await client.query('select billing_reserve($1,$2,$3,$4,$5,$6,$7) r', [
      subject,
      family,
      key,
      hash,
      'TEST',
      'acct_test',
      params,
    ])
  ).rows[0].r;
}
async function claim(id?: string) {
  return (
    await db.query('select billing_claim_account($1,$2,$3) r', [
      'TEST',
      'acct_test',
      id ?? null,
    ])
  ).rows[0].r;
}
async function apply(a: any, facts: unknown = []) {
  await db.query('select billing_apply_snapshot($1,$2,$3,$4)', [
    a.id,
    a.lease_token,
    a.version,
    JSON.stringify(facts),
  ]);
}
const facts = (id = 'sub_test', status = 'active') => ({
  id,
  price: 'price_test',
  status,
  cancelAtPeriodEnd: false,
  cancelAt: null,
  periodStart: '2026-10-01T00:00:00Z',
  periodEnd: '2026-11-01T00:00:00Z',
  trialEnd: null,
  invoiceId: 'in_test',
  invoiceStatus: 'paid',
  paidThrough: '2026-11-01T00:00:00Z',
});
describe.skipIf(!hasDatabase())('durable Stripe billing boundary', () => {
  beforeEach(async () => {
    db = await connect();
    await applySchema(db);
    seed = await seedFamily(db);
    other = await seedFamily(db);
    await db.query('create role anon nologin').catch(() => {});
    await db.query(
      'alter table auth.users add column email_confirmed_at timestamptz',
    );
    await db.query(
      "update auth.users set email=id::text||'@example.test',email_confirmed_at=now()",
    );
    for (const s of sql) await db.query(s);
  });
  afterEach(async () => {
    await db?.end();
  });
  it('migration creates no provider accounts, subscriptions or charges', async () => {
    expect(
      (await db.query('select count(*)::int n from billing_accounts')).rows[0]
        .n,
    ).toBe(0);
    expect(
      (await db.query('select id from families order by id')).rows,
    ).toHaveLength(2);
  });
  it('replays keys, rejects changed bodies and serializes concurrent duplicate clicks', async () => {
    const key = randomUUID(),
      peer = await connect();
    try {
      const result = await Promise.all([
        reserve(db, key),
        reserve(peer, key),
        reserve(peer),
      ]);
      expect(new Set(result.map((r) => r.attempt.id)).size).toBe(1);
      expect(result.filter((r) => r.created)).toHaveLength(1);
      await expect(reserve(db, key, 'other')).rejects.toThrow(
        'IDEMPOTENCY_CONFLICT',
      );
    } finally {
      await peer.end();
    }
  });
  it('authorizes owner under the family lock and keeps foreign attempts private', async () => {
    const { attempt } = await reserve();
    await expect(
      db.query('select billing_owner_state($1,$2,$3,$4)', [
        other.authUserId,
        other.familyId,
        'TEST',
        attempt.id,
      ]),
    ).rejects.toThrow('NOT_FOUND');
    await expect(
      reserve(db, randomUUID(), 'hash', other.authUserId, seed.familyId),
    ).rejects.toThrow('FORBIDDEN');
  });
  it('fences expired workers after restart and emits an atomic outbox snapshot', async () => {
    await reserve();
    const first = await claim();
    expect(await claim()).toBe(null);
    await db.query(
      "update billing_accounts set lease_until=now()-interval '1 second' where id=$1",
      [first.id],
    );
    const next = await claim();
    expect(next.version).toBe(first.version + 1);
    await expect(apply(first)).rejects.toThrow('BILLING_FENCE_LOST');
    await apply(next, [facts()]);
    expect(
      (await db.query('select snapshot_version from billing_change_outbox'))
        .rows[0].snapshot_version,
    ).toBe(String(next.version));
  });
  it('unknown creation remains unresolved across requests and leases', async () => {
    const { attempt } = await reserve();
    const a = await claim();
    await db.query('select billing_finish_operation($1,$2,$3,null,$4,$5)', [
      a.id,
      a.lease_token,
      a.version,
      attempt.id,
      { state: 'UNKNOWN' },
    ]);
    await db.query('select billing_fail_account($1,$2,$3)', [
      a.id,
      a.lease_token,
      'PROVIDER_UNAVAILABLE',
    ]);
    expect((await reserve()).attempt.id).toBe(attempt.id);
  });
  it('reconciles all subscriptions so an old canceled subscription cannot displace a new active one', async () => {
    await reserve();
    const a = await claim();
    await apply(a, [facts('sub_old', 'canceled'), facts('sub_new', 'active')]);
    await expect(reserve()).rejects.toThrow('SUBSCRIPTION_EXISTS');
    expect(
      (await db.query('select count(*)::int n from billing_subscriptions'))
        .rows[0].n,
    ).toBe(2);
  });
  it('quarantines multiple active subscriptions and missing recognized subscriptions', async () => {
    await reserve();
    let a = await claim();
    await apply(a, [facts('sub_one'), facts('sub_two')]);
    expect(
      (await db.query('select alert from billing_accounts')).rows[0].alert,
    ).toBe('MULTIPLE_SUBSCRIPTIONS');
    expect(
      (await db.query('select * from billing_change_outbox')).rows,
    ).toHaveLength(0);
    await expect(reserve()).rejects.toThrow('BILLING_UNAVAILABLE');
    a = await claim(a.id);
    await apply(a, []);
    expect(
      (await db.query('select alert from billing_accounts')).rows[0].alert,
    ).toBe('MULTIPLE_SUBSCRIPTIONS');
  });
  it('deduplicates the durable inbox, leases workers and retries/replays with an audit', async () => {
    for (let i = 0; i < 2; i++)
      await db.query(
        "select billing_ingest('TEST','acct_test','evt_test','invoice.paid','in_test','cus_test',now(),true)",
      );
    const first = (
      await db.query("select billing_claim_event('TEST','acct_test') r")
    ).rows[0].r;
    expect(first.attempts).toBe(1);
    expect(
      (await db.query("select billing_claim_event('TEST','acct_test') r"))
        .rows[0].r,
    ).toBe(null);
    await db.query(
      "select billing_finish_event($1,$2,'FAILED','UNMAPPED_EVENT')",
      [first.id, first.lease_token],
    );
    await db.query('select billing_replay_event($1)', [first.id]);
    expect(
      (await db.query("select billing_claim_event('TEST','acct_test') r"))
        .rows[0].r.attempts,
    ).toBe(1);
    expect(
      (
        await db.query(
          "select operation from billing_audit_events where operation='OPERATOR_REPLAY'",
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('does not grant activation from a paid invoice or applied inbox without a consumed entitlement receipt', async () => {
    const { attempt } = await reserve();
    const a = await claim();
    await apply(a, [facts()]);
    let state = (
      await db.query('select billing_owner_state($1,$2,$3,$4) r', [
        seed.authUserId,
        seed.familyId,
        'TEST',
        attempt.id,
      ])
    ).rows[0].r;
    expect(state.activation).toBe(false);
    await db.query(
      'insert into billing_activation_receipts values($1,$2,now())',
      [a.id, a.version],
    );
    state = (
      await db.query('select billing_owner_state($1,$2,$3) r', [
        seed.authUserId,
        seed.familyId,
        'TEST',
      ])
    ).rows[0].r;
    expect(state.activation).toBe(true);
  });
  it('preserves verified paid-through evidence across renewal failure', async () => {
    await reserve();
    let a = await claim();
    await apply(a, [facts()]);
    a = await claim(a.id);
    await apply(a, [
      {
        ...facts(),
        status: 'past_due',
        invoiceStatus: 'open',
        paidThrough: null,
      },
    ]);
    expect(
      (
        await db.query('select paid_through from billing_subscriptions')
      ).rows[0].paid_through.toISOString(),
    ).toBe('2026-11-01T00:00:00.000Z');
  });
  it('requires a fresh provider reconciliation before a new attempt after expiration', async () => {
    const { attempt } = await reserve();
    const a = await claim();
    await db.query('select billing_finish_operation($1,$2,$3,$4,$5,$6)', [
      a.id,
      a.lease_token,
      a.version,
      'cus_test',
      attempt.id,
      { state: 'EXPIRED' },
    ]);
    expect((await reserve()).processing).toBe(true);
    await apply(a);
    expect((await reserve()).created).toBe(true);
  });
  it('keeps TEST/LIVE and merchant mappings isolated and denies browser tables/RPCs', async () => {
    await reserve();
    expect(
      (await db.query("select billing_claim_account('LIVE','acct_test') r"))
        .rows[0].r,
    ).toBe(null);
    await db.query('grant usage on schema public to authenticated');
    for (const query of [
      'select * from billing_accounts',
      "select billing_claim_account('TEST','acct_test')",
      'select * from billing_activation_receipts',
    ]) {
      await db.query('begin');
      await db.query('set local role authenticated');
      await expect(db.query(query)).rejects.toThrow('permission denied');
      await db.query('rollback');
    }
  });
  it('quarantines missing previously recognized active subscriptions instead of guessing cancellation', async () => {
    await reserve();
    let a = await claim();
    await apply(a, [facts()]);
    a = await claim(a.id);
    await apply(a, []);
    expect(
      (await db.query('select alert from billing_accounts')).rows[0].alert,
    ).toBe('MISSING_SUBSCRIPTION');
  });
  it('bounds failed account retries and audits explicit operator release', async () => {
    await reserve();
    let a = await claim();
    await db.query('select billing_fail_account($1,$2,$3,false,1)', [
      a.id,
      a.lease_token,
      'PROVIDER_UNAVAILABLE',
    ]);
    expect(
      (await db.query('select quarantined from billing_accounts')).rows[0]
        .quarantined,
    ).toBe(true);
    await db.query('select billing_release_quarantine($1,$2)', [
      a.id,
      'INCIDENT-123-reviewed',
    ]);
    expect(
      (await db.query('select quarantined from billing_accounts')).rows[0]
        .quarantined,
    ).toBe(false);
    await expect(apply(a)).rejects.toThrow('BILLING_FENCE_LOST');
    expect(
      (
        await db.query(
          "select operation from billing_audit_events where operation='OPERATOR_REVIEW_RELEASE'",
        )
      ).rows,
    ).toHaveLength(1);
  });
});
