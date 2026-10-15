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
const migrations = await Promise.all(
  [
    '007_membership_access.sql',
    '008_member_views.sql',
    '009_tenant_onboarding.sql',
    '010_stripe_billing.sql',
    '011_subscription_entitlements.sql',
  ].map((f) =>
    readFile(
      new URL('../../src/supabase/migrations/' + f, import.meta.url),
      'utf8',
    ),
  ),
);
const stamp = '2026-10-15T12:00:00Z';
const policy = {
  version: 'test-v1',
  approval: 'TEST-ONLY-POLICY',
  enforcementEnabled: true,
  graceDays: 7,
  outageHours: 24,
  trialsEnabled: false,
  legacyDeadline: '2030-01-01T00:00:00Z',
  mode: 'TEST',
  merchant: 'acct_fixture',
  priceId: 'price_fixture',
  exceptionPolicy: 'RESTRICT',
  memberLimit: 3,
};
const future = () => new Date(Date.now() + 3600000).toISOString();
async function configure(p: unknown = policy) {
  await db.query('select entitlement_configure($1)', [p]);
}
async function effective(family = seed.familyId) {
  return (await db.query('select entitlement_effective($1) r', [family]))
    .rows[0].r;
}
async function project(family = seed.familyId) {
  await db.query(
    "update entitlement_jobs set due_at=clock_timestamp()+interval '1 hour' where family_id<>$1",
    [family],
  );
  await db.query(
    "update entitlement_jobs set due_at=clock_timestamp()-interval '1 minute' where family_id=$1",
    [family],
  );
  const j = (await db.query('select entitlement_claim() r')).rows[0].r;
  expect(j?.family_id).toBe(family);
  await db.query('select entitlement_project($1,$2)', [family, j.lease_token]);
  return j;
}
async function snapshot(
  family = seed.familyId,
  auth = seed.authUserId,
  patch: Record<string, unknown> = {},
) {
  let account = (
    await db.query('select id from billing_accounts where family_id=$1', [
      family,
    ])
  ).rows[0]?.id;
  if (!account) {
    await db.query('select billing_reserve($1,$2,$3,$4,$5,$6,$7)', [
      auth,
      family,
      randomUUID(),
      'hash',
      'TEST',
      'acct_fixture',
      { price: 'price_fixture', origin: 'https://app.example.test' },
    ]);
    account = (
      await db.query('select id from billing_accounts where family_id=$1', [
        family,
      ])
    ).rows[0].id;
  }
  const a = (
    await db.query("select billing_claim_account('TEST','acct_fixture',$1) r", [
      account,
    ])
  ).rows[0].r;
  const attempt = (
    await db.query(
      'select id from billing_checkout_attempts where account_id=$1 order by created_at limit 1',
      [a.id],
    )
  ).rows[0];
  await db.query('select billing_finish_operation($1,$2,$3,$4,$5,$6)', [
    a.id,
    a.lease_token,
    a.version,
    'cus_' + family,
    attempt.id,
    { id: 'cs_' + family, state: 'COMPLETED', subscription: 'sub_' + family },
  ]);
  const facts = {
    id: 'sub_' + family,
    price: 'price_fixture',
    status: 'active',
    cancelAtPeriodEnd: false,
    cancelAt: null,
    periodStart: new Date(Date.now() - 3600000).toISOString(),
    periodEnd: future(),
    trialEnd: null,
    invoiceId: 'in_' + family,
    invoiceStatus: 'paid',
    paidThrough: future(),
    ...patch,
  };
  await db.query('select billing_apply_snapshot($1,$2,$3,$4)', [
    a.id,
    a.lease_token,
    a.version,
    JSON.stringify([facts]),
  ]);
  return a;
}
async function selfService() {
  const auth = randomUUID();
  await db.query(
    'insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',
    [auth, auth + '@example.test'],
  );
  const result = (
    await db.query('select create_tenant($1,$2,$3,$4,$5,true) r', [
      auth,
      auth + '@example.test',
      randomUUID(),
      'hash',
      {
        name: 'Draft family',
        responsible_name: 'Owner',
        relationship: 'OTHER',
      },
    ])
  ).rows[0].r;
  return { auth, family: result.family.id };
}
describe.skipIf(!hasDatabase())(
  'subscription entitlement policy and transactions',
  () => {
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
      for (const sql of migrations) await db.query(sql);
    });
    afterEach(async () => {
      await db?.end();
    });
    it.each([
      [
        'unconfirmed first purchase',
        {
          source: 'NONE',
          established: false,
          status: 'active',
          paidThrough: null,
        },
        'DRAFT',
        false,
      ],
      [
        'paid until exact cutoff',
        { source: 'STRIPE', status: 'active', paidThrough: stamp },
        'READ_ONLY',
        false,
      ],
      [
        'paid before cutoff',
        {
          source: 'STRIPE',
          status: 'active',
          paidThrough: '2026-10-16T00:00:00Z',
        },
        'ACTIVE',
        true,
      ],
      [
        'failed first payment',
        {
          source: 'STRIPE',
          established: false,
          status: 'past_due',
          paidThrough: null,
          graceEndsAt: '2026-10-17T00:00:00Z',
        },
        'DRAFT',
        false,
      ],
      [
        'fixed renewal grace',
        {
          source: 'STRIPE',
          status: 'past_due',
          paidThrough: stamp,
          graceEndsAt: '2026-10-16T00:00:00Z',
        },
        'GRACE',
        true,
      ],
      [
        'expired renewal grace',
        {
          source: 'STRIPE',
          status: 'past_due',
          paidThrough: stamp,
          graceEndsAt: stamp,
        },
        'READ_ONLY',
        false,
      ],
      [
        'scheduled cancellation ignores outage',
        {
          source: 'STRIPE',
          status: 'active',
          paidThrough: stamp,
          scheduledCancellation: true,
          providerUnavailable: true,
          outageEndsAt: '2026-10-16T00:00:00Z',
        },
        'READ_ONLY',
        false,
      ],
      [
        'known canceled ignores outage',
        {
          source: 'STRIPE',
          status: 'canceled',
          paidThrough: stamp,
          providerUnavailable: true,
          outageEndsAt: '2026-10-16T00:00:00Z',
        },
        'READ_ONLY',
        false,
      ],
      [
        'terminal unpaid',
        {
          source: 'STRIPE',
          status: 'unpaid',
          paidThrough: '2026-10-16T00:00:00Z',
        },
        'READ_ONLY',
        false,
      ],
      [
        'paused',
        {
          source: 'STRIPE',
          status: 'paused',
          paidThrough: '2026-10-16T00:00:00Z',
        },
        'READ_ONLY',
        false,
      ],
      [
        'unknown status',
        {
          source: 'STRIPE',
          status: 'future_status',
          paidThrough: '2026-10-16T00:00:00Z',
        },
        'READ_ONLY',
        false,
      ],
      [
        'trial disabled',
        {
          source: 'STRIPE',
          status: 'trialing',
          trialEndsAt: '2026-10-16T00:00:00Z',
        },
        'READ_ONLY',
        false,
      ],
      [
        'approved trial',
        {
          source: 'STRIPE',
          status: 'trialing',
          trialsEnabled: true,
          trialEndsAt: '2026-10-16T00:00:00Z',
        },
        'TRIAL',
        true,
      ],
      [
        'fixed outage',
        {
          source: 'STRIPE',
          status: 'active',
          paidThrough: stamp,
          providerUnavailable: true,
          outageEndsAt: '2026-10-16T00:00:00Z',
        },
        'ACTIVE',
        true,
      ],
      [
        'expired outage',
        {
          source: 'STRIPE',
          status: 'active',
          paidThrough: stamp,
          providerUnavailable: true,
          outageEndsAt: stamp,
        },
        'READ_ONLY',
        false,
      ],
      [
        'legacy deadline',
        {
          source: 'LEGACY_MIGRATION',
          legacyEligible: true,
          legacyEndsAt: stamp,
        },
        'READ_ONLY',
        false,
      ],
      [
        'consumed legacy cannot return',
        {
          source: 'LEGACY_MIGRATION',
          legacyEligible: true,
          legacyConsumed: true,
          legacyEndsAt: null,
        },
        'READ_ONLY',
        false,
      ],
    ] as const)('%s', async (_name, patch, state, canWrite) => {
      const result = (
        await db.query('select entitlement_decision($1,$2) r', [
          {
            established: true,
            profileComplete: true,
            approved: true,
            source: 'NONE',
            ...patch,
          },
          stamp,
        ])
      ).rows[0].r;
      expect(result.state).toBe(state);
      expect(result.canWrite).toBe(canWrite);
    });
    it('preserves configured legacy access under the explicit bootstrap policy and blocks drafts', async () => {
      expect((await effective()).state).toBe('LEGACY');
      const draft = await selfService();
      expect((await effective(draft.family)).state).toBe('DRAFT');
      await expect(
        db.query('select access_actor($1,$2)', [draft.auth, draft.family]),
      ).rejects.toThrow('SUBSCRIPTION_REQUIRED');
    });
    it('atomically establishes the same paid draft, consumes outbox and confirms activation only afterward', async () => {
      await configure();
      const draft = await selfService();
      const a = await snapshot(draft.family, draft.auth);
      expect((await effective(draft.family)).canWrite).toBe(false);
      expect(
        (
          await db.query('select entitlement_activation_confirmed($1) r', [
            a.id,
          ])
        ).rows[0].r,
      ).toBe(false);
      await project(draft.family);
      expect((await effective(draft.family)).state).toBe('ACTIVE');
      expect(
        (
          await db.query('select id,lifecycle from families where id=$1', [
            draft.family,
          ])
        ).rows[0],
      ).toEqual({ id: draft.family, lifecycle: 'ESTABLISHED' });
      expect(
        (
          await db.query('select entitlement_activation_confirmed($1) r', [
            a.id,
          ])
        ).rows[0].r,
      ).toBe(true);
      expect(
        (
          await db.query(
            'select consumed_at from billing_change_outbox where account_id=$1',
            [a.id],
          )
        ).rows[0].consumed_at,
      ).not.toBe(null);
    });
    it('does not reproject the same snapshot or let a provider read lease hide activation', async () => {
      await configure();
      const a = await snapshot();
      await project();
      const before = (
        await db.query(
          'select version from family_entitlements where family_id=$1',
          [seed.familyId],
        )
      ).rows[0].version;
      await project();
      expect(
        (
          await db.query(
            'select version from family_entitlements where family_id=$1',
            [seed.familyId],
          )
        ).rows[0].version,
      ).toBe(before);
      await db.query("select billing_claim_account('TEST','acct_fixture',$1)", [
        a.id,
      ]);
      expect(
        (
          await db.query('select entitlement_activation_confirmed($1) r', [
            a.id,
          ])
        ).rows[0].r,
      ).toBe(true);
    });
    it('keeps renewal failure and its grace cutoff fixed across repeated failures and policy changes', async () => {
      await configure();
      const cutoff = new Date(Date.now() - 3600000).toISOString();
      await snapshot(seed.familyId, seed.authUserId, { paidThrough: cutoff });
      await project();
      await snapshot(seed.familyId, seed.authUserId, {
        status: 'past_due',
        invoiceStatus: 'open',
        paidThrough: cutoff,
      });
      await project();
      const before = (
        await db.query(
          'select first_renewal_failure_at,grace_ends_at from family_entitlements where family_id=$1',
          [seed.familyId],
        )
      ).rows[0];
      expect((await effective()).state).toBe('GRACE');
      await configure({ ...policy, version: 'test-v2', graceDays: 14 });
      await snapshot(seed.familyId, seed.authUserId, {
        status: 'past_due',
        invoiceStatus: 'open',
        paidThrough: cutoff,
      });
      await project();
      expect(
        (
          await db.query(
            'select first_renewal_failure_at,grace_ends_at from family_entitlements where family_id=$1',
            [seed.familyId],
          )
        ).rows[0],
      ).toEqual(before);
    });
    it('never returns a converted canceled legacy family to legacy access', async () => {
      await configure();
      await snapshot();
      await project();
      expect((await effective()).state).toBe('ACTIVE');
      await snapshot(seed.familyId, seed.authUserId, {
        status: 'canceled',
        paidThrough: new Date(Date.now() - 1000).toISOString(),
      });
      // billing facts preserve historical paid-through; force a clock boundary in the projection fixture.
      await db.query(
        "update family_entitlements set paid_through=clock_timestamp()-interval '1 second' where family_id=$1",
        [seed.familyId],
      );
      expect((await effective()).state).toBe('READ_ONLY');
      expect(
        (
          await db.query(
            'select legacy_conversion_consumed from entitlement_cohorts where family_id=$1',
            [seed.familyId],
          )
        ).rows[0].legacy_conversion_consumed,
      ).toBe(true);
    });
    it('enforces a persisted legacy deadline even if global enforcement is later disabled', async () => {
      await configure({ ...policy, legacyDeadline: '2020-01-01T00:00:00Z' });
      await db.query("select entitlement_rollout($1,true,'reviewed-cohort')", [
        seed.familyId,
      ]);
      expect((await effective()).state).toBe('READ_ONLY');
      await configure({
        ...policy,
        version: 'disabled-v2',
        enforcementEnabled: false,
        legacyDeadline: null,
      });
      expect((await effective()).state).toBe('READ_ONLY');
      await expect(
        db.query("select entitlement_rollout($1,false,'unbounded-rollback')", [
          seed.familyId,
        ]),
      ).rejects.toThrow('VALIDATION');
    });
    it('uses bounded audited exceptions, never a draft or role bypass', async () => {
      await configure({ ...policy, legacyDeadline: '2020-01-01T00:00:00Z' });
      await db.query("select entitlement_rollout($1,true,'reviewed-cohort')", [
        seed.familyId,
      ]);
      await db.query('select entitlement_rollout($1,true,$2,$3)', [
        seed.familyId,
        'INCIDENT-TEST',
        future(),
      ]);
      expect((await effective()).canWrite).toBe(true);
      const draft = await selfService();
      await expect(
        db.query('select entitlement_rollout($1,true,$2,$3)', [
          draft.family,
          'BAD',
          future(),
        ]),
      ).rejects.toThrow('VALIDATION');
      await expect(
        db.query('select access_actor($1,$2)', [
          other.authUserId,
          seed.familyId,
        ]),
      ).rejects.toThrow('FORBIDDEN');
    });
    it('fails closed when the projection row is missing and denies browser/private RPC bypass', async () => {
      await db.query('delete from family_entitlements where family_id=$1', [
        seed.familyId,
      ]);
      await expect(
        db.query('select access_actor($1,$2)', [
          seed.authUserId,
          seed.familyId,
        ]),
      ).rejects.toThrow('ENTITLEMENT_UNAVAILABLE');
      for (const fn of [
        'private_complete_task(uuid,uuid,uuid)',
        'private_reopen_task(uuid)',
        'private_resource_write(uuid,uuid,text,text,uuid,jsonb,text)',
      ])
        expect(
          (
            await db.query(
              "select has_function_privilege('service_role',$1,'EXECUTE') ok",
              [fn],
            )
          ).rows[0].ok,
        ).toBe(false);
      expect(
        (
          await db.query(
            "select has_function_privilege('authenticated','entitlement_decision(jsonb,timestamptz)','EXECUTE') ok",
          )
        ).rows[0].ok,
      ).toBe(false);
    });
    it('fences expired projection workers and preserves history across restriction/resubscription', async () => {
      await configure();
      await snapshot();
      await project();
      const task = (
        await db.query(
          "select authorized_resource_write($1,$2,'tasks','insert',null,$3,null) r",
          [
            seed.authUserId,
            seed.familyId,
            {
              title: 'A chore',
              status: 'TODO',
              points: 17,
              assigned_member_id: seed.memberId,
            },
          ],
        )
      ).rows[0].r[0].id;
      await db.query(
        "select authorized_family_action($1,$2,'complete_task',$3)",
        [
          seed.authUserId,
          seed.familyId,
          {
            p_task_id: task,
            p_member_id: seed.memberId,
            p_responsible_user_id: seed.responsibleUserId,
          },
        ],
      );
      const ledger = (
        await db.query(
          'select id,member_id,points,transaction_type from points_transactions',
        )
      ).rows;
      await snapshot(seed.familyId, seed.authUserId, { status: 'unpaid' });
      expect((await effective()).canWrite).toBe(false);
      await project();
      await expect(
        db.query("select authorized_family_action($1,$2,'reopen_task',$3)", [
          seed.authUserId,
          seed.familyId,
          { p_task_id: task },
        ]),
      ).rejects.toThrow('SUBSCRIPTION_REQUIRED');
      await snapshot(seed.familyId, seed.authUserId, {
        paidThrough: new Date(Date.now() + 7200000).toISOString(),
      });
      await project();
      expect((await effective()).canWrite).toBe(true);
      expect(
        (
          await db.query(
            'select id,member_id,points,transaction_type from points_transactions',
          )
        ).rows,
      ).toEqual(ledger);
    });
    it('requires published approved policy before any new checkout operation', async () => {
      await expect(
        db.query('select billing_reserve($1,$2,$3,$4,$5,$6,$7)', [
          seed.authUserId,
          seed.familyId,
          randomUUID(),
          'hash',
          'TEST',
          'acct_fixture',
          { price: 'price_fixture' },
        ]),
      ).rejects.toThrow('POLICY_CONFIGURATION_REQUIRED');
      expect(
        (await db.query('select * from billing_accounts')).rows,
      ).toHaveLength(0);
    });
    it('rolls back lifecycle, projection, receipt and outbox together on a forced projection failure', async () => {
      await configure();
      const draft = await selfService();
      const a = await snapshot(draft.family, draft.auth);
      await db.query(
        "update entitlement_jobs set due_at=clock_timestamp()+interval '1 hour' where family_id<>$1",
        [draft.family],
      );
      const job = (await db.query('select entitlement_claim() r')).rows[0].r;
      await db.query(
        "create function fail_projection_test() returns trigger language plpgsql as $$ begin if new.operation='PROJECTION' then raise exception 'forced projection failure';end if;return new;end $$; create trigger fail_projection before insert on entitlement_events for each row execute function fail_projection_test()",
      );
      await expect(
        db.query('select entitlement_project($1,$2)', [
          draft.family,
          job.lease_token,
        ]),
      ).rejects.toThrow('forced projection failure');
      expect(
        (
          await db.query('select lifecycle from families where id=$1', [
            draft.family,
          ])
        ).rows[0].lifecycle,
      ).toBe('DRAFT');
      expect(
        (
          await db.query(
            'select * from billing_activation_receipts where account_id=$1',
            [a.id],
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await db.query(
            'select consumed_at from billing_change_outbox where account_id=$1',
            [a.id],
          )
        ).rows[0].consumed_at,
      ).toBe(null);
      await db.query('drop trigger fail_projection on entitlement_events');
      await db.query('select entitlement_project($1,$2)', [
        draft.family,
        job.lease_token,
      ]);
      expect((await effective(draft.family)).state).toBe('ACTIVE');
    });
    it('rejects stale projection leases and never consumes newer outbox state from an older fence', async () => {
      await configure();
      await snapshot();
      await db.query(
        "update entitlement_jobs set due_at=clock_timestamp()+interval '1 hour' where family_id<>$1",
        [seed.familyId],
      );
      const first = (await db.query('select entitlement_claim() r')).rows[0].r;
      await db.query(
        "update entitlement_jobs set lease_until=clock_timestamp()-interval '1 second' where family_id=$1",
        [seed.familyId],
      );
      const next = (await db.query('select entitlement_claim() r')).rows[0].r;
      expect(next.lease_token).not.toBe(first.lease_token);
      await expect(
        db.query('select entitlement_project($1,$2)', [
          seed.familyId,
          first.lease_token,
        ]),
      ).rejects.toThrow('ENTITLEMENT_FENCE_LOST');
      await db.query('select entitlement_project($1,$2)', [
        seed.familyId,
        next.lease_token,
      ]);
      expect((await effective()).state).toBe('ACTIVE');
    });
    it('keeps provider outage extension fixed and does not restore it after a known terminal restriction', async () => {
      await configure();
      const through = new Date(Date.now() - 3600000).toISOString();
      const a = await snapshot(seed.familyId, seed.authUserId, {
        paidThrough: through,
      });
      await project();
      await db.query(
        "update billing_accounts set alert='PROVIDER_UNAVAILABLE' where id=$1",
        [a.id],
      );
      let access = await effective();
      expect(access.canWrite).toBe(true);
      const until = access.effectiveUntil;
      await project();
      expect((await effective()).effectiveUntil).toBe(until);
      await snapshot(seed.familyId, seed.authUserId, {
        status: 'unpaid',
        paidThrough: through,
      });
      expect((await effective()).canWrite).toBe(false);
      await snapshot(seed.familyId, seed.authUserId, {
        status: 'active',
        paidThrough: through,
      });
      await db.query(
        "update billing_accounts set alert='PROVIDER_UNAVAILABLE' where id=$1",
        [a.id],
      );
      expect((await effective()).canWrite).toBe(false);
      await project();
      expect((await effective()).canWrite).toBe(false);
    });
    it('keeps revoked membership authoritative and allows only the narrow audited security revocation in READ_ONLY', async () => {
      const memberAuth = randomUUID(),
        email = memberAuth + '@example.test';
      const member = (
        await db.query(
          "select authorized_resource_write($1,$2,'family_members','insert',null,$3,null) r",
          [
            seed.authUserId,
            seed.familyId,
            {
              name: 'Reader',
              member_type: 'CHILD',
              access: { enabled: true, email, role: 'MEMBER' },
            },
          ],
        )
      ).rows[0].r[0].id;
      await db.query(
        'insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',
        [memberAuth, email],
      );
      await db.query('select resolve_membership($1,$2)', [memberAuth, email]);
      await configure();
      await snapshot();
      await project();
      await snapshot(seed.familyId, seed.authUserId, { status: 'unpaid' });
      expect((await effective()).state).toBe('READ_ONLY');
      expect(
        (
          await db.query("select member_view_read($1,'directory') r", [
            memberAuth,
          ])
        ).rows[0].r.members,
      ).toHaveLength(2);
      await expect(
        db.query('select set_member_access($1,$2,$3,$4)', [
          seed.authUserId,
          seed.familyId,
          member,
          { enabled: true, role: 'MANAGER', expectedVersion: 2 },
        ]),
      ).rejects.toThrow('SUBSCRIPTION_REQUIRED');
      await db.query(
        "select security_revoke_access($1,$2,$3,2,'SECURITY-INCIDENT')",
        [seed.authUserId, seed.familyId, member],
      );
      await expect(
        db.query('select access_actor($1,$2)', [memberAuth, seed.familyId]),
      ).rejects.toThrow('ACCESS_REVOKED');
      expect(
        (
          await db.query(
            "select previous_status,new_status from access_audit_events where action='SECURITY_REVOKE'",
          )
        ).rows[0],
      ).toEqual({ previous_status: 'ACTIVE', new_status: 'REVOKED' });
      await expect(
        db.query('select security_revoke_access($1,$2,$3,2)', [
          seed.authUserId,
          seed.familyId,
          member,
        ]),
      ).rejects.toThrow('ACCESS_VERSION_CONFLICT');
    });
    it('enforces the explicit paid member cap and immutable policy version', async () => {
      await configure({ ...policy, memberLimit: 1 });
      await snapshot();
      await project();
      await expect(
        db.query(
          "select authorized_resource_write($1,$2,'family_members','insert',null,$3,null)",
          [
            seed.authUserId,
            seed.familyId,
            { name: 'Over cap', member_type: 'CHILD' },
          ],
        ),
      ).rejects.toThrow('MEMBER_LIMIT_REACHED');
      await expect(configure({ ...policy, memberLimit: 10 })).rejects.toThrow(
        'POLICY_VERSION_CONFLICT',
      );
    });
    it.each(['complete_task', 'reopen_task', 'redeem_award', 'crud'])(
      'serializes %s against a billing restriction with no partial ledger changes',
      async (operation) => {
        await configure();
        await snapshot();
        await project();
        const task = (
          await db.query(
            "select authorized_resource_write($1,$2,'tasks','insert',null,$3,null) r",
            [
              seed.authUserId,
              seed.familyId,
              {
                title: 'Race chore',
                status: 'TODO',
                points: 17,
                assigned_member_id: seed.memberId,
              },
            ],
          )
        ).rows[0].r[0].id;
        if (operation !== 'complete_task')
          await db.query(
            "select authorized_family_action($1,$2,'complete_task',$3)",
            [
              seed.authUserId,
              seed.familyId,
              { p_task_id: task, p_member_id: seed.memberId },
            ],
          );
        const award = (
          await db.query(
            "select authorized_resource_write($1,$2,'awards','insert',null,$3,null) r",
            [
              seed.authUserId,
              seed.familyId,
              { title: 'Reward', points_cost: 1 },
            ],
          )
        ).rows[0].r[0].id;
        const before = (
          await db.query(
            'select id,points,transaction_type from points_transactions order by id',
          )
        ).rows;
        const peer = await connect();
        try {
          const a = (
            await peer.query(
              "select billing_claim_account('TEST','acct_fixture',id) r from billing_accounts where family_id=$1",
              [seed.familyId],
            )
          ).rows[0].r;
          await peer.query('begin');
          await peer.query('select id from families where id=$1 for update', [
            seed.familyId,
          ]);
          const write =
            operation === 'crud'
              ? db.query(
                  "select authorized_resource_write($1,$2,'tasks','update',$3,$4,null)",
                  [
                    seed.authUserId,
                    seed.familyId,
                    task,
                    { title: 'Must not commit' },
                  ],
                )
              : db.query('select authorized_family_action($1,$2,$3,$4)', [
                  seed.authUserId,
                  seed.familyId,
                  operation,
                  {
                    p_task_id: task,
                    p_award_id: award,
                    p_member_id: seed.memberId,
                  },
                ]);
          const pending = write.then(
            () => null,
            (error: Error) => error,
          );
          for (let i = 0; i < 100; i++) {
            const row = (
              await peer.query(
                'select wait_event_type from pg_stat_activity where pid=$1',
                [db.processID],
              )
            ).rows[0];
            if (row?.wait_event_type === 'Lock') break;
            await new Promise((resolve) => setTimeout(resolve, 10));
            if (i === 99) throw new Error('write never waited for family lock');
          }
          await peer.query('select billing_apply_snapshot($1,$2,$3,$4)', [
            a.id,
            a.lease_token,
            a.version,
            JSON.stringify([
              {
                id: 'sub_' + seed.familyId,
                price: 'price_fixture',
                status: 'unpaid',
                cancelAtPeriodEnd: false,
                paidThrough: future(),
              },
            ]),
          ]);
          await peer.query('commit');
          expect((await pending)?.message).toBe('SUBSCRIPTION_REQUIRED');
          expect(
            (
              await db.query(
                'select id,points,transaction_type from points_transactions order by id',
              )
            ).rows,
          ).toEqual(before);
          expect(
            (await db.query('select title from tasks where id=$1', [task]))
              .rows[0].title,
          ).toBe('Race chore');
        } finally {
          await peer.query('rollback');
          await peer.end();
        }
      },
    );
    it('uses clock_timestamp after lock wait rather than transaction-start time', async () => {
      await configure();
      const cutoff = new Date(Date.now() + 1200).toISOString();
      await snapshot(seed.familyId, seed.authUserId, { paidThrough: cutoff });
      await project();
      const peer = await connect();
      try {
        await peer.query('begin');
        await peer.query('select id from families where id=$1 for update', [
          seed.familyId,
        ]);
        await db.query('begin');
        expect(
          (
            await db.query('select now()<$1::timestamptz before_cutoff', [
              cutoff,
            ])
          ).rows[0].before_cutoff,
        ).toBe(true);
        const write = db
          .query(
            "select authorized_resource_write($1,$2,'tasks','insert',null,$3,null)",
            [
              seed.authUserId,
              seed.familyId,
              { title: 'Expired while waiting', status: 'TODO' },
            ],
          )
          .then(
            () => null,
            (error: Error) => error,
          );
        await new Promise((resolve) => setTimeout(resolve, 1400));
        await peer.query('commit');
        expect((await write)?.message).toBe('SUBSCRIPTION_REQUIRED');
        await db.query('rollback');
        expect(
          (
            await db.query(
              "select id from tasks where title='Expired while waiting'",
            )
          ).rows,
        ).toHaveLength(0);
      } finally {
        await db.query('rollback');
        await peer.query('rollback');
        await peer.end();
      }
    });
    it('serializes a membership revocation before a waiting manager write', async () => {
      const subject = randomUUID(),
        email = subject + '@example.test';
      const manager = (
        await db.query(
          "select authorized_resource_write($1,$2,'family_members','insert',null,$3,null) r",
          [
            seed.authUserId,
            seed.familyId,
            {
              name: 'Manager',
              member_type: 'PARENT',
              access: { enabled: true, email, role: 'MANAGER' },
            },
          ],
        )
      ).rows[0].r[0].id;
      await db.query(
        'insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',
        [subject, email],
      );
      await db.query('select resolve_membership($1,$2)', [subject, email]);
      await configure();
      await snapshot();
      await project();
      const peer = await connect();
      try {
        await peer.query('begin');
        await peer.query('select id from families where id=$1 for update', [
          seed.familyId,
        ]);
        const pending = db
          .query(
            "select authorized_resource_write($1,$2,'tasks','insert',null,$3,null)",
            [
              subject,
              seed.familyId,
              { title: 'Revoked manager must not write', status: 'TODO' },
            ],
          )
          .then(
            () => null,
            (error: Error) => error,
          );
        for (let i = 0; i < 100; i++) {
          if (
            (
              await peer.query(
                'select wait_event_type from pg_stat_activity where pid=$1',
                [db.processID],
              )
            ).rows[0]?.wait_event_type === 'Lock'
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await peer.query('select security_revoke_access($1,$2,$3,2)', [
          seed.authUserId,
          seed.familyId,
          manager,
        ]);
        await peer.query('commit');
        expect((await pending)?.message).toBe('ACCESS_REVOKED');
        expect(
          (
            await db.query(
              "select id from tasks where title='Revoked manager must not write'",
            )
          ).rows,
        ).toHaveLength(0);
      } finally {
        await peer.query('rollback');
        await peer.end();
      }
    });
    it('retains a valid completion when its transaction commits before the waiting restriction', async () => {
      await configure();
      await snapshot();
      await project();
      const task = (
        await db.query(
          "select authorized_resource_write($1,$2,'tasks','insert',null,$3,null) r",
          [
            seed.authUserId,
            seed.familyId,
            {
              title: 'First committed chore',
              status: 'TODO',
              points: 17,
              assigned_member_id: seed.memberId,
            },
          ],
        )
      ).rows[0].r[0].id;
      const peer = await connect();
      try {
        const a = (
          await peer.query(
            "select billing_claim_account('TEST','acct_fixture',id) r from billing_accounts where family_id=$1",
            [seed.familyId],
          )
        ).rows[0].r;
        await db.query('begin');
        await db.query(
          "select authorized_family_action($1,$2,'complete_task',$3)",
          [
            seed.authUserId,
            seed.familyId,
            { p_task_id: task, p_member_id: seed.memberId },
          ],
        );
        const pending = peer.query(
          'select billing_apply_snapshot($1,$2,$3,$4)',
          [
            a.id,
            a.lease_token,
            a.version,
            JSON.stringify([
              {
                id: 'sub_' + seed.familyId,
                price: 'price_fixture',
                status: 'unpaid',
                cancelAtPeriodEnd: false,
                paidThrough: future(),
              },
            ]),
          ],
        );
        for (let i = 0; i < 100; i++) {
          if (
            (
              await db.query(
                'select wait_event_type from pg_stat_activity where pid=$1',
                [peer.processID],
              )
            ).rows[0]?.wait_event_type === 'Lock'
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await db.query('commit');
        await pending;
        expect((await effective()).canWrite).toBe(false);
        expect(
          (await db.query('select status from tasks where id=$1', [task]))
            .rows[0].status,
        ).toBe('DONE');
        expect(
          (
            await db.query(
              'select points from points_transactions where task_id=$1',
              [task],
            )
          ).rows[0].points,
        ).toBe(17);
      } finally {
        await db.query('rollback');
        await peer.end();
      }
    });
    it('protects read-only established settings from the onboarding alias while preserving metadata recovery', async () => {
      await configure({ ...policy, legacyDeadline: '2020-01-01T00:00:00Z' });
      await db.query("select entitlement_rollout($1,true,'reviewed')", [
        seed.familyId,
      ]);
      expect(
        (await db.query('select tenant_onboarding($1) r', [seed.authUserId]))
          .rows[0].r.nextAction,
      ).toBe('OPEN_DASHBOARD');
      await expect(
        db.query('select tenant_onboarding($1,$2)', [
          seed.authUserId,
          { name: 'Must not edit' },
        ]),
      ).rejects.toThrow('SUBSCRIPTION_REQUIRED');
    });
    it('rehearses migration on existing completed work without changing IDs, ledger sums or owner actor mappings', async () => {
      await applySchema(db);
      seed = await seedFamily(db);
      const task = (
        await db.query(
          "insert into tasks(family_id,title,created_by_user_id,status,points,assigned_member_id) values($1,'Historical chore',$2,'TODO',17,$3) returning id",
          [seed.familyId, seed.responsibleUserId, seed.memberId],
        )
      ).rows[0].id;
      await db.query('select complete_task($1,$2,$3)', [
        task,
        seed.memberId,
        seed.responsibleUserId,
      ]);
      const before = (
        await db.query(
          'select id,family_id,member_id,task_id,points,transaction_type from points_transactions',
        )
      ).rows;
      const completions = (
        await db.query(
          'select id,task_id,family_id,completed_by_member_id from task_completions',
        )
      ).rows;
      await db.query(
        'alter table auth.users add column email_confirmed_at timestamptz',
      );
      for (const sql of migrations) await db.query(sql);
      expect(
        (
          await db.query(
            'select id,family_id,member_id,task_id,points,transaction_type from points_transactions',
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await db.query(
            'select id,task_id,family_id,completed_by_member_id from task_completions',
          )
        ).rows,
      ).toEqual(completions);
      expect(
        (
          await db.query(
            'select t.created_by_app_user_id=u.id ok from tasks t join app_users u on u.auth_user_id=$1 where t.id=$2',
            [seed.authUserId, task],
          )
        ).rows[0].ok,
      ).toBe(true);
      expect((await effective()).state).toBe('LEGACY');
    });
    it('preserves browser self-history RLS while the family is read-only', async () => {
      const subject = randomUUID(),
        email = subject + '@example.test';
      const member = (
        await db.query(
          "select authorized_resource_write($1,$2,'family_members','insert',null,$3,null) r",
          [
            seed.authUserId,
            seed.familyId,
            {
              name: 'Reader',
              member_type: 'CHILD',
              access: { enabled: true, email, role: 'MEMBER' },
            },
          ],
        )
      ).rows[0].r[0].id;
      await db.query(
        'insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',
        [subject, email],
      );
      await db.query('select resolve_membership($1,$2)', [subject, email]);
      for (const [person, points] of [
        [seed.memberId, 17],
        [member, 5],
      ]) {
        const task = (
          await db.query(
            "select authorized_resource_write($1,$2,'tasks','insert',null,$3,null) r",
            [
              seed.authUserId,
              seed.familyId,
              {
                title: 'Private history',
                status: 'TODO',
                points,
                assigned_member_id: person,
              },
            ],
          )
        ).rows[0].r[0].id;
        await db.query(
          "select authorized_family_action($1,$2,'complete_task',$3)",
          [
            seed.authUserId,
            seed.familyId,
            { p_task_id: task, p_member_id: person },
          ],
        );
      }
      await configure();
      await snapshot();
      await project();
      await snapshot(seed.familyId, seed.authUserId, { status: 'unpaid' });
      expect((await effective()).state).toBe('READ_ONLY');
      await db.query(
        `create or replace function auth.uid() returns uuid language sql stable as $$ select '${subject}'::uuid $$`,
      );
      await db.query(
        'grant usage on schema public,auth to authenticated;grant select on points_transactions,family_members to authenticated',
      );
      await db.query('begin');
      await db.query('set local role authenticated');
      expect(
        (await db.query('select member_id,points from points_transactions'))
          .rows,
      ).toEqual([{ member_id: member, points: 5 }]);
      expect(
        (await db.query('select id from family_members')).rows,
      ).toHaveLength(0);
      await db.query('rollback');
      await db.query('begin');
      await db.query('set local role authenticated');
      await expect(
        db.query('select completed_by_app_user_id from task_completions'),
      ).rejects.toThrow('permission denied');
      await db.query('rollback');
    });
  },
);
