import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  applySchema,
  connect,
  hasDatabase,
  seedFamily,
  seedTask,
  type PgClient,
} from './db-harness.js';
let db: PgClient;
let seed: Awaited<ReturnType<typeof seedFamily>>;
let other: Awaited<ReturnType<typeof seedFamily>>;
const migration = await readFile(
  new URL(
    '../../src/supabase/migrations/007_membership_access.sql',
    import.meta.url,
  ),
  'utf8',
);
const actor = async () =>
  (
    await db.query('select id from app_users where auth_user_id=$1', [
      seed.authUserId,
    ])
  ).rows[0].id;
async function createMember(email: string, role = 'MEMBER') {
  const { rows } = await db.query(
    `select authorized_resource_write($1,$2,'family_members','insert',null,$3::jsonb,'test') as result`,
    [
      seed.authUserId,
      seed.familyId,
      JSON.stringify({
        name: 'Login person',
        member_type: 'PARENT',
        access: { enabled: true, email, role },
      }),
    ],
  );
  return rows[0].result[0].id as string;
}
async function claim(email: string, auth = randomUUID()) {
  await db.query(
    'insert into auth.users(id,email) values($1,$2) on conflict(id) do nothing',
    [auth, email],
  );
  const r = await db.query(
    'select resolve_membership($1,$2,null,null,true) as result',
    [auth, email],
  );
  return { auth, ...r.rows[0].result };
}
describe.skipIf(!hasDatabase())(
  'membership migration and transaction authorization',
  () => {
    beforeEach(async () => {
      db = await connect();
      await applySchema(db);
      seed = await seedFamily(db);
      other = await seedFamily(db);
      await seedTask(db, seed, { points: 12 });
      await db.query('create role anon nologin').catch(() => {});
      await db.query(
        'alter table auth.users add column email_confirmed_at timestamptz',
      );
      await db.query(
        "update auth.users set email=id::text||'@example.test',email_confirmed_at=now()",
      );
      await db.query(migration);
    });
    afterEach(async () => {
      await db?.end();
    });
    it('backfills owners, actors and balances without new households', async () => {
      expect(
        (await db.query('select count(*)::int n from families')).rows[0].n,
      ).toBe(2);
      const r = await db.query(
        'select role,status from family_memberships where family_id=$1',
        [seed.familyId],
      );
      expect(r.rows[0]).toEqual({ role: 'OWNER', status: 'ACTIVE' });
      expect(
        (await db.query('select created_by_app_user_id from tasks')).rows[0]
          .created_by_app_user_id,
      ).toBe(await actor());
      const auth = randomUUID();
      await db.query('insert into auth.users(id) values($1)', [auth]);
      expect(
        (
          await db.query(
            'select resolve_membership($1,null,null,null,true) r',
            [auth],
          )
        ).rows[0].r.state,
      ).toBe('NO_ACCESS');
      expect(
        (await db.query('select count(*)::int n from families')).rows[0].n,
      ).toBe(2);
    });
    it('atomically provisions normalized email with explicit role, reserves revoked email and rejects duplicates', async () => {
      const member = await createMember(
        ' Mixed+alias@Example.test ',
        'MANAGER',
      );
      const login = await claim('mixed+alias@example.test');
      expect(login.membership.member_id).toBe(member);
      expect(login.membership.role).toBe('MANAGER');
      await expect(createMember('MIXED+alias@example.test')).rejects.toThrow(
        'ACCESS_CONFLICT',
      );
      await expect(
        db.query("update access_audit_events set action='tampered'"),
      ).rejects.toThrow('FORBIDDEN');
      const version = login.membership.access_version;
      await db.query('select set_member_access($1,$2,$3,$4,null)', [
        seed.authUserId,
        seed.familyId,
        member,
        { enabled: false, expectedVersion: version },
      ]);
      const again = await db.query(
        'select resolve_membership($1,$2,null,null,true) r',
        [login.auth, 'mixed+alias@example.test'],
      );
      expect(again.rows[0].r.state).toBe('REVOKED');
      await expect(createMember('mixed+alias@example.test')).rejects.toThrow(
        'ACCESS_CONFLICT',
      );
    });
    it('member cannot write, browser cannot invoke privileged RPCs, and cross-family references fail closed', async () => {
      const member = await createMember('member@example.test');
      const login = await claim('member@example.test');
      await expect(
        db.query(
          "select authorized_resource_write($1,$2,'tasks','insert',null,$3,null)",
          [login.auth, seed.familyId, { title: 'forbidden' }],
        ),
      ).rejects.toThrow('FORBIDDEN');
      await expect(
        db.query(
          "select authorized_resource_write($1,$2,'tasks','insert',null,$3,null)",
          [
            seed.authUserId,
            seed.familyId,
            { title: 'foreign', assigned_member_id: other.memberId },
          ],
        ),
      ).rejects.toThrow('VALIDATION');
      await expect(
        db.query('select set_member_access($1,$2,$3,$4,null)', [
          seed.authUserId,
          other.familyId,
          member,
          { enabled: false, expectedVersion: 2 },
        ]),
      ).rejects.toThrow('FORBIDDEN');
      const grants = await db.query(
        `select has_function_privilege('authenticated','complete_task(uuid,uuid,uuid)','execute') old_rpc,has_function_privilege('anon','authorized_resource_write(uuid,uuid,text,text,uuid,jsonb,text)','execute') new_rpc`,
      );
      expect(grants.rows[0]).toEqual({ old_rpc: false, new_rpc: false });
    });
    it('additional manager creates and completes using their own canonical actor', async () => {
      const member = await createMember('manager@example.test', 'MANAGER');
      const login = await claim('manager@example.test');
      const { rows } = await db.query(
        "select authorized_resource_write($1,$2,'tasks','insert',null,$3,null) r",
        [
          login.auth,
          seed.familyId,
          { title: 'Manager task', points: 7, assigned_member_id: member },
        ],
      );
      const task = rows[0].r[0];
      expect(task.created_by_user_id).toBeNull();
      expect(task.created_by_app_user_id).toBe(login.user.id);
      await db.query(
        "select authorized_family_action($1,$2,'complete_task',$3)",
        [
          login.auth,
          seed.familyId,
          { p_task_id: task.id, p_member_id: member },
        ],
      );
      const completion = (
        await db.query('select * from task_completions where task_id=$1', [
          task.id,
        ])
      ).rows[0];
      expect(completion.completed_by_app_user_id).toBe(login.user.id);
      expect(completion.completed_by_user_id).toBeNull();
      await db.query(
        "select authorized_family_action($1,$2,'reopen_task',$3)",
        [login.auth, seed.familyId, { p_task_id: task.id }],
      );
      expect(
        (
          await db.query(
            'select sum(points)::int n from points_transactions where member_id=$1',
            [member],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it('deactivation revokes immediately, version conflicts reject, and owner deletion is blocked', async () => {
      const member = await createMember('active@example.test');
      const login = await claim('active@example.test');
      await expect(
        db.query('select set_member_access($1,$2,$3,$4,null)', [
          seed.authUserId,
          seed.familyId,
          member,
          { enabled: true, expectedVersion: 1 },
        ]),
      ).rejects.toThrow('ACCESS_VERSION_CONFLICT');
      await db.query(
        "select authorized_resource_write($1,$2,'family_members','update',$3,$4,null)",
        [seed.authUserId, seed.familyId, member, { active: false }],
      );
      expect(
        (
          await db.query('select resolve_membership($1,$2,null,null,true) r', [
            login.auth,
            'active@example.test',
          ])
        ).rows[0].r.state,
      ).toBe('REVOKED');
      await expect(
        db.query('delete from auth.users where id=$1', [seed.authUserId]),
      ).rejects.toThrow('foreign key');
      await expect(
        db.query(
          "update family_memberships set role='MANAGER' where app_user_id=$1",
          [await actor()],
        ),
      ).rejects.toThrow('FORBIDDEN');
    });
    it('email replacement is verified-subject bound, single-use, cancellable and preserves member identity', async () => {
      const member = await createMember('old@example.test');
      const login = await claim('old@example.test');
      await db.query(
        'select begin_membership_email_change($1,$2,$3,$4,$5,$6,null)',
        [
          seed.authUserId,
          seed.familyId,
          member,
          'new@example.test',
          2,
          'hash-1',
        ],
      );
      await expect(
        db.query('select confirm_membership_email_change($1,$2,$3,null)', [
          seed.authUserId,
          'new@example.test',
          'hash-1',
        ]),
      ).rejects.toThrow('INVALID_EMAIL_CHANGE');
      await expect(
        db.query('select confirm_membership_email_change($1,$2,$3,null)', [
          login.auth,
          'old@example.test',
          'hash-1',
        ]),
      ).rejects.toThrow('INVALID_EMAIL_CHANGE');
      await db.query('select confirm_membership_email_change($1,$2,$3,null)', [
        login.auth,
        'new@example.test',
        'hash-1',
      ]);
      await expect(
        db.query('select confirm_membership_email_change($1,$2,$3,null)', [
          login.auth,
          'new@example.test',
          'hash-1',
        ]),
      ).rejects.toThrow('INVALID_EMAIL_CHANGE');
      const r = (
        await db.query('select resolve_membership($1,$2,null,null,true) r', [
          login.auth,
          'new@example.test',
        ])
      ).rows[0].r;
      expect(r.membership.member_id).toBe(member);
      expect(r.membership.status).toBe('ACTIVE');
    });
    it('concurrent first claims bind only one subject', async () => {
      await createMember('race@example.test');
      const a = randomUUID(),
        b = randomUUID();
      await db.query('insert into auth.users(id,email) values($1,$3),($2,$3)', [
        a,
        b,
        'race@example.test',
      ]);
      const second = await connect();
      try {
        const results = await Promise.allSettled([
          db.query('select resolve_membership($1,$2,null,null,true) r', [
            a,
            'race@example.test',
          ]),
          second.query('select resolve_membership($1,$2,null,null,true) r', [
            b,
            'race@example.test',
          ]),
        ]);
        expect(
          results.filter(
            (r) =>
              r.status === 'fulfilled' && r.value.rows[0].r.state === 'READY',
          ),
        ).toHaveLength(1);
        expect(
          (
            await db.query(
              "select count(*)::int n from family_memberships where login_email='race@example.test' and app_user_id is not null",
            )
          ).rows[0].n,
        ).toBe(1);
      } finally {
        await second.end();
      }
    });
    it('a mutation waiting behind committed revocation fails closed', async () => {
      const member = await createMember('ordered@example.test', 'MANAGER');
      const login = await claim('ordered@example.test');
      const second = await connect();
      try {
        await db.query('begin');
        await db.query('select set_member_access($1,$2,$3,$4,null)', [
          seed.authUserId,
          seed.familyId,
          member,
          { enabled: false, expectedVersion: 2 },
        ]);
        const write = second
          .query(
            "select authorized_resource_write($1,$2,'tasks','insert',null,$3,null)",
            [login.auth, seed.familyId, { title: 'Must not commit' }],
          )
          .then(
            () => null,
            (error) => error,
          );
        await db.query('commit');
        expect((await write)?.message).toBe('ACCESS_REVOKED');
        expect(
          (
            await db.query(
              "select count(*)::int n from tasks where title='Must not commit'",
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        await db.query('rollback');
        await second.end();
      }
    });
    it('expired replacement cannot restore access and a manager can cancel it', async () => {
      const member = await createMember('expiry@example.test');
      const login = await claim('expiry@example.test');
      await db.query(
        'select begin_membership_email_change($1,$2,$3,$4,$5,$6,null)',
        [
          seed.authUserId,
          seed.familyId,
          member,
          'replacement@example.test',
          2,
          'expired-hash',
        ],
      );
      await db.query(
        "update membership_email_changes set expires_at=now()-interval '1 second'",
      );
      await expect(
        db.query('select confirm_membership_email_change($1,$2,$3,null)', [
          login.auth,
          'replacement@example.test',
          'expired-hash',
        ]),
      ).rejects.toThrow('INVALID_EMAIL_CHANGE');
      await db.query('select set_member_access($1,$2,$3,$4,null)', [
        seed.authUserId,
        seed.familyId,
        member,
        { enabled: true, expectedVersion: 3 },
      ]);
      expect(
        (
          await db.query('select resolve_membership($1,$2,null,null,true) r', [
            login.auth,
            'expiry@example.test',
          ])
        ).rows[0].r.state,
      ).toBe('READY');
      await expect(
        db.query('select confirm_membership_email_change($1,$2,$3,null)', [
          login.auth,
          'replacement@example.test',
          'expired-hash',
        ]),
      ).rejects.toThrow('INVALID_EMAIL_CHANGE');
    });
    it('RLS allows only personal history, denies private roster and loses access after revocation', async () => {
      const member = await createMember('private@example.test');
      const login = await claim('private@example.test');
      await db.query(
        "insert into points_transactions(family_id,member_id,points,transaction_type) values($1,$2,4,'MANUAL_ADJUSTMENT'),($1,$3,9,'MANUAL_ADJUSTMENT')",
        [seed.familyId, member, seed.memberId],
      );
      await db.query(
        `create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$`,
      );
      await db.query(
        'grant usage on schema public,auth to authenticated; grant select on points_transactions,family_members to authenticated',
      );
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        login.auth,
      ]);
      await db.query('set role authenticated');
      expect(
        (await db.query('select points from points_transactions')).rows,
      ).toEqual([{ points: 4 }]);
      expect((await db.query('select * from family_members')).rows).toEqual([]);
      await db.query('reset role');
      await db.query('select set_member_access($1,$2,$3,$4,null)', [
        seed.authUserId,
        seed.familyId,
        member,
        { enabled: false, expectedVersion: 2 },
      ]);
      await db.query('set role authenticated');
      expect(
        (await db.query('select * from points_transactions')).rows,
      ).toEqual([]);
      await db.query('reset role');
    });
  },
);
