import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import {
  applySchema,
  connect,
  hasDatabase,
  seedFamily,
  seedTask,
  type PgClient,
} from './db-harness.js';
let db: PgClient,
  legacy: Awaited<ReturnType<typeof seedFamily>>,
  auth: string,
  key: string;
const profile = {
  name: 'New Family',
  responsible_name: 'New Owner',
  relationship: 'OTHER',
};
const migrations = await Promise.all(
  [
    '007_membership_access.sql',
    '008_member_views.sql',
    '009_tenant_onboarding.sql',
  ].map((f) =>
    readFile(
      new URL('../../src/supabase/migrations/' + f, import.meta.url),
      'utf8',
    ),
  ),
);
async function create(
  client = db,
  subject = auth,
  requestKey = key,
  hash = 'hash',
  body: unknown = profile,
  enabled = true,
  email = subject + '@example.test',
) {
  return (
    await client.query('select create_tenant($1,$2,$3,$4,$5,$6) r', [
      subject,
      email,
      requestKey,
      hash,
      body,
      enabled,
    ])
  ).rows[0].r;
}
async function newIdentity() {
  const id = randomUUID();
  await db.query(
    'insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',
    [id, id + '@example.test'],
  );
  return id;
}
describe.skipIf(!hasDatabase())('explicit tenant lifecycle', () => {
  beforeEach(async () => {
    db = await connect();
    await applySchema(db);
    legacy = await seedFamily(db);
    await db.query('create role anon nologin').catch(() => {});
    await db.query(
      'alter table auth.users add column email_confirmed_at timestamptz',
    );
    await db.query(
      "update auth.users set email=id::text||'@example.test',email_confirmed_at=now()",
    );
    for (const sql of migrations) await db.query(sql);
    auth = await newIdentity();
    key = randomUUID();
  });
  afterEach(async () => {
    await db?.end();
  });
  it('login alone never creates a tenant; explicit creation is an unpaid isolated OWNER draft', async () => {
    await db.query('select resolve_membership($1,$2)', [
      auth,
      auth + '@example.test',
    ]);
    expect(
      (await db.query('select count(*)::int n from families')).rows[0].n,
    ).toBe(1);
    const result = await create();
    expect(result).toMatchObject({
      created: true,
      lifecycle: 'DRAFT',
      profileCompleted: true,
      nextAction: 'SUBSCRIBE',
      family: profile,
    });
    expect(
      (
        await db.query(
          'select role,status from family_memberships m join app_users u on u.id=m.app_user_id where u.auth_user_id=$1',
          [auth],
        )
      ).rows[0],
    ).toEqual({ role: 'OWNER', status: 'ACTIVE' });
    expect(
      (
        await db.query(
          'select established_at,creation_source,legacy_access_eligible from families where id=$1',
          [result.family.id],
        )
      ).rows[0],
    ).toEqual({
      established_at: null,
      creation_source: 'SELF_SERVICE',
      legacy_access_eligible: false,
    });
  });
  it('replays and different request keys resume the same family, including with signup disabled', async () => {
    const first = await create();
    const second = await create();
    const third = await create(
      db,
      auth,
      randomUUID(),
      'changed',
      profile,
      false,
    );
    expect(second).toEqual({ ...first, created: false });
    expect(third.family.id).toBe(first.family.id);
    await expect(create(db, auth, key, 'different')).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
    expect(
      (await db.query('select count(*)::int n from tenant_creation_requests'))
        .rows[0].n,
    ).toBe(2);
  });
  it('serializes concurrent creation with same and different keys', async () => {
    const peer = await connect();
    try {
      const results = await Promise.all([
        create(),
        create(peer),
        create(peer, auth, randomUUID()),
      ]);
      expect(new Set(results.map((r) => r.family.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
    } finally {
      await peer.end();
    }
  });
  it('rolls back all ownership rows after failure and permits the same key to retry', async () => {
    await db.query(
      "create function fail_tenant_request() returns trigger language plpgsql as $$ begin raise exception 'forced failure'; end $$; create trigger fail_request before insert on tenant_creation_requests for each row execute function fail_tenant_request()",
    );
    await expect(create()).rejects.toThrow('forced failure');
    expect(
      (
        await db.query(
          'select count(*)::int n from responsible_users where auth_user_id=$1',
          [auth],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await db.query(
          'select count(*)::int n from app_users where auth_user_id=$1',
          [auth],
        )
      ).rows[0].n,
    ).toBe(0);
    await db.query('drop trigger fail_request on tenant_creation_requests');
    expect((await create()).created).toBe(true);
  });
  it('kill switch and verification reject creation without partial ownership', async () => {
    await expect(create(db, auth, key, 'hash', profile, false)).rejects.toThrow(
      'SIGNUP_UNAVAILABLE',
    );
    await expect(
      create(db, auth, key, 'hash', profile, true, ''),
    ).rejects.toThrow('EMAIL_VERIFICATION_REQUIRED');
    expect(
      (await db.query('select count(*)::int n from families')).rows[0].n,
    ).toBe(1);
  });
  it.each([
    { ...profile, role: 'OWNER' },
    { ...profile, name: ' ' },
    { ...profile, responsible_name: '' },
    { ...profile, relationship: 'ADMIN' },
    { ...profile, lifecycle: 'ESTABLISHED' },
  ])('rejects invalid or server-owned creation fields %j', async (body) => {
    await expect(create(db, auth, key, 'hash', body)).rejects.toThrow(
      'VALIDATION',
    );
  });
  it('keeps drafts recoverable and profile changes atomic without granting product access', async () => {
    const first = await create();
    const result = (
      await db.query('select tenant_onboarding($1,$2) r', [
        auth,
        { name: 'Renamed', responsible_name: 'Updated' },
      ])
    ).rows[0].r;
    expect(result).toMatchObject({
      nextAction: 'SUBSCRIBE',
      family: {
        id: first.family.id,
        name: 'Renamed',
        responsible_name: 'Updated',
      },
    });
    await expect(
      db.query('select tenant_onboarding($1,$2)', [
        auth,
        { name: 'Invalid change', relationship: 'ADMIN' },
      ]),
    ).rejects.toThrow('VALIDATION');
    expect(
      (await db.query('select tenant_onboarding($1) r', [auth])).rows[0].r,
    ).toEqual(result);
    await expect(
      db.query('select access_actor($1,$2)', [auth, first.family.id]),
    ).rejects.toThrow('TENANT_ACCESS_RESTRICTED');
    await expect(
      db.query("select member_view_read($1,'directory')", [auth]),
    ).rejects.toThrow('TENANT_ACCESS_RESTRICTED');
    await expect(
      db.query(
        "select authorized_resource_write($1,$2,'family_members','insert',null,$3,null)",
        [auth, first.family.id, { name: 'Bypass', member_type: 'CHILD' }],
      ),
    ).rejects.toThrow('TENANT_ACCESS_RESTRICTED');
  });
  it('preserves legacy identifiers/history and explicitly allows configured legacy access', async () => {
    expect(
      (await db.query('select tenant_onboarding($1) r', [legacy.authUserId]))
        .rows[0].r,
    ).toMatchObject({
      lifecycle: 'ESTABLISHED',
      nextAction: 'OPEN_DASHBOARD',
      family: { id: legacy.familyId },
    });
    expect(
      (
        await db.query('select tenant_product_access($1) allowed', [
          legacy.familyId,
        ])
      ).rows[0].allowed,
    ).toBe(true);
    expect(
      (
        await db.query(
          'select count(*)::int n from family_members where id=$1',
          [legacy.memberId],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it('completes an incomplete legacy profile on the same family without checkout', async () => {
    // Rehearse backfill with an actually incomplete pre-migration household.
    await applySchema(db);
    legacy = await seedFamily(db);
    await db.query(
      'alter table auth.users add column email_confirmed_at timestamptz',
    );
    await db.query('update responsible_users set name=null,relationship=null');
    for (const sql of migrations) await db.query(sql);
    expect(
      (await db.query('select tenant_onboarding($1) r', [legacy.authUserId]))
        .rows[0].r.nextAction,
    ).toBe('COMPLETE_PROFILE');
    expect(
      (
        await db.query('select tenant_onboarding($1,$2) r', [
          legacy.authUserId,
          profile,
        ])
      ).rows[0].r,
    ).toMatchObject({
      lifecycle: 'ESTABLISHED',
      nextAction: 'OPEN_DASHBOARD',
      family: { id: legacy.familyId },
    });
  });
  it('reserves provisioned and revoked mailboxes and rejects ordinary members', async () => {
    const participant = (
      await db.query(
        "select authorized_resource_write($1,$2,'family_members','insert',null,$3,null) r",
        [
          legacy.authUserId,
          legacy.familyId,
          {
            name: 'Member',
            member_type: 'CHILD',
            access: {
              enabled: true,
              email: auth + '@example.test',
              role: 'MEMBER',
            },
          },
        ],
      )
    ).rows[0].r[0];
    await expect(create()).rejects.toThrow('TENANT_ASSOCIATION_CONFLICT');
    await db.query('select resolve_membership($1,$2)', [
      auth,
      auth + '@example.test',
    ]);
    await expect(create()).rejects.toThrow('TENANT_ASSOCIATION_CONFLICT');
    await expect(
      db.query('select tenant_onboarding($1)', [auth]),
    ).rejects.toThrow('FORBIDDEN');
    await db.query(
      "update family_memberships set status='REVOKED' where member_id=$1",
      [participant.id],
    );
    await expect(create()).rejects.toThrow('TENANT_ASSOCIATION_CONFLICT');
  });
  it('arbitrates an in-flight manager provision by the unique normalized mailbox constraint', async () => {
    const peer = await connect();
    try {
      await db.query('begin');
      await db.query(
        "select authorized_resource_write($1,$2,'family_members','insert',null,$3,null)",
        [
          legacy.authUserId,
          legacy.familyId,
          {
            name: 'Reserved',
            member_type: 'CHILD',
            access: {
              enabled: true,
              email: auth + '@example.test',
              role: 'MEMBER',
            },
          },
        ],
      );
      const pending = create(peer);
      await db.query('commit');
      await expect(pending).rejects.toThrow('TENANT_ASSOCIATION_CONFLICT');
      expect(
        (
          await db.query(
            'select count(*)::int n from responsible_users where auth_user_id=$1',
            [auth],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await db.query('rollback');
      await peer.end();
    }
  });
  it('browser roles cannot read draft rows or invoke privileged lifecycle/read RPCs', async () => {
    const result = await create();
    // Administrator fixtures ensure an accidental RLS allowance would expose rows.
    await db.query("insert into family_members(family_id,name,member_type) values($1,'Draft private participant','CHILD')",[result.family.id]);
    await db.query(
      `create or replace function auth.uid() returns uuid language sql stable as $$ select '${auth}'::uuid $$`,
    );
    await db.query(
      'grant usage on schema public,auth to authenticated; grant select on family_members,points_transactions,awards to authenticated',
    );
    await db.query('begin');
    await db.query('set local role authenticated');
    expect((await db.query('select (current_access()).id id')).rows[0].id).toBe(
      null,
    );
    expect((await db.query('select * from family_members')).rows).toHaveLength(
      0,
    );
    await db.query('rollback');
    for (const call of [
      'select * from tenant_creation_requests',
      'select tenant_onboarding($1)',
      "select member_view_read($1,'directory')",
      'select tenant_product_access($1)',
    ]) {
      await db.query('begin');
      await db.query('set local role authenticated');
      await expect(
        db.query(
          call,
          call.includes('$1')
            ? [call.includes('product_access') ? result.family.id : auth]
            : [],
        ),
      ).rejects.toThrow('permission denied');
      await db.query('rollback');
    }
    expect(
      (
        await db.query(
          "select has_function_privilege('service_role','member_view_snapshot(uuid,text,jsonb)','EXECUTE') allowed",
        )
      ).rows[0].allowed,
    ).toBe(false);
    await expect(
      db.query(
        "update families set creation_source='LEGACY',legacy_access_eligible=true where id=$1",
        [result.family.id],
      ),
    ).rejects.toThrow('FORBIDDEN');
  });
  it('preserves legacy ledger and completion identifiers during migration', async () => {
    await applySchema(db);
    legacy = await seedFamily(db);
    const task = await seedTask(db, legacy, { points: 17 });
    await db.query('select complete_task($1,$2,$3)', [
      task,
      legacy.memberId,
      legacy.responsibleUserId,
    ]);
    const before = (
      await db.query(
        'select id,task_id,member_id,points,transaction_type from points_transactions',
      )
    ).rows;
    const completion = (
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
          'select id,task_id,member_id,points,transaction_type from points_transactions',
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await db.query(
          'select id,task_id,family_id,completed_by_member_id from task_completions',
        )
      ).rows,
    ).toEqual(completion);
  });
  it('serializes a concurrent membership claim and explicit creation without a second tenant', async () => {
    await db.query(
      "select authorized_resource_write($1,$2,'family_members','insert',null,$3,null)",
      [
        legacy.authUserId,
        legacy.familyId,
        {
          name: 'Reserved',
          member_type: 'CHILD',
          access: {
            enabled: true,
            email: auth + '@example.test',
            role: 'MEMBER',
          },
        },
      ],
    );
    const peer = await connect();
    try {
      const outcomes = await Promise.allSettled([
        db.query('select resolve_membership($1,$2)', [
          auth,
          auth + '@example.test',
        ]),
        create(peer),
      ]);
      expect(outcomes[0].status).toBe('fulfilled');
      expect(outcomes[1].status).toBe('rejected');
      expect(
        (await db.query('select count(*)::int n from families')).rows[0].n,
      ).toBe(1);
    } finally {
      await peer.end();
    }
  });
  it('cannot provision a mailbox already owned by a self-service draft', async () => {
    await create();
    await expect(
      db.query(
        "select authorized_resource_write($1,$2,'family_members','insert',null,$3,null)",
        [
          legacy.authUserId,
          legacy.familyId,
          {
            name: 'Collision',
            member_type: 'CHILD',
            access: {
              enabled: true,
              email: auth + '@example.test',
              role: 'MEMBER',
            },
          },
        ],
      ),
    ).rejects.toThrow('ACCESS_CONFLICT');
    expect(
      (
        await db.query(
          "select count(*)::int n from family_members where name='Collision'",
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it('keeps profile completion truthful through established settings without reverting lifecycle', async () => {
    await db.query('update responsible_users set name=null where id=$1', [
      legacy.responsibleUserId,
    ]);
    expect(
      (await db.query('select tenant_onboarding($1) r', [legacy.authUserId]))
        .rows[0].r,
    ).toMatchObject({
      lifecycle: 'ESTABLISHED',
      profileCompleted: false,
      nextAction: 'COMPLETE_PROFILE',
    });
    expect(
      (await db.query('select tenant_product_access($1) r', [legacy.familyId]))
        .rows[0].r,
    ).toBe(false);
  });
});
