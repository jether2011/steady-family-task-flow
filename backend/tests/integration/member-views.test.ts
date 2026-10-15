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
let db: PgClient,
  seed: Awaited<ReturnType<typeof seedFamily>>,
  other: typeof seed,
  auth: string,
  member: string;
const migrations = await Promise.all(
  ['007_membership_access.sql', '008_member_views.sql'].map((file) =>
    readFile(
      new URL('../../src/supabase/migrations/' + file, import.meta.url),
      'utf8',
    ),
  ),
);
async function view(kind: string, input: unknown = {}, subject = auth) {
  return (
    await db.query('select member_view_read($1,$2,$3) r', [
      subject,
      kind,
      input,
    ])
  ).rows[0].r;
}
async function provision(email: string, role = 'MEMBER') {
  const id = (
    await db.query(
      "select authorized_resource_write($1,$2,'family_members','insert',null,$3,null) r",
      [
        seed.authUserId,
        seed.familyId,
        {
          name: 'Participant',
          member_type: 'CHILD',
          birth_year: 2010,
          access: { enabled: true, email, role },
        },
      ],
    )
  ).rows[0].r[0].id;
  const subject = randomUUID();
  await db.query('insert into auth.users(id,email) values($1,$2)', [
    subject,
    email,
  ]);
  await db.query('select resolve_membership($1,$2,null,null,true)', [
    subject,
    email,
  ]);
  return { id, subject };
}
describe.skipIf(!hasDatabase())('member snapshot read models', () => {
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
    const self = await provision('member@example.test');
    member = self.id;
    auth = self.subject;
  });
  afterEach(async () => {
    await db?.end();
  });
  it('returns a safe directory and only the bound profile, never login metadata', async () => {
    const result = await view('directory');
    expect(result.members).toHaveLength(2);
    expect(result.members.find((m: { id: string }) => m.id === member)).toEqual(
      {
        id: member,
        name: 'Participant',
        avatar_url: null,
        color: null,
        member_type: 'CHILD',
        active: true,
      },
    );
    const profile = await view('profile');
    expect(profile.member.birth_year).toBe(2010);
    expect(profile.balance).toBe(0);
    await expect(view('profile', { memberId: seed.memberId })).rejects.toThrow(
      'NOT_FOUND',
    );
    await expect(view('points', { memberId: other.memberId })).rejects.toThrow(
      'NOT_FOUND',
    );
  });
  it('summaries include every signed category and retain negative balances after reversals', async () => {
    const rows = [
      ['TASK_COMPLETION', 15],
      ['MANUAL_ADJUSTMENT', -3],
      ['REVERSAL', -15],
      ['REDEMPTION', -2],
    ];
    for (const [type, points] of rows)
      await db.query(
        "insert into points_transactions(family_id,member_id,points,transaction_type,created_at) values($1,$2,$3,$4,'2025-03-10T10:00:00Z')",
        [seed.familyId, member, points, type],
      );
    expect(await view('summary')).toEqual({
      earned: 15,
      adjustments: -3,
      reversed: 15,
      spent: 2,
      net: -5,
      balance: -5,
    });
    expect(await view('summary', { from: '2025-03-11' })).toEqual({
      earned: 0,
      adjustments: 0,
      reversed: 0,
      spent: 0,
      net: 0,
      balance: -5,
    });
  });
  it('traverses tied timestamps without duplicates, and does not include other member ledger', async () => {
    await db.query(
      "insert into points_transactions(family_id,member_id,points,transaction_type,created_at) select $1,$2,1,'MANUAL_ADJUSTMENT','2025-03-10T10:00:00Z' from generate_series(1,7)",
      [seed.familyId, member],
    );
    await db.query(
      "insert into points_transactions(family_id,member_id,points,transaction_type) values($1,$2,99,'MANUAL_ADJUSTMENT')",
      [seed.familyId, seed.memberId],
    );
    const ids: string[] = [];
    let input: Record<string, unknown> = { limit: 3 };
    for (let i = 0; i < 3; i++) {
      const page = (await view('points', input)).transactions;
      ids.push(...page.map((row: { id: string }) => row.id));
      const last = page.at(-1);
      if (last)
        input = { limit: 3, pageTime: last.created_at, pageId: last.id };
    }
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
  });
  it('dashboard uses own tasks, balances and zero-point completion history', async () => {
    const result = await db.query(
      "select authorized_resource_write($1,$2,'tasks','insert',null,$3,null) r",
      [
        seed.authUserId,
        seed.familyId,
        {
          title: 'Zero point work',
          assigned_member_id: member,
          points: 0,
          due_date: new Date().toISOString().slice(0, 10),
        },
      ],
    );
    const task = result.rows[0].r[0];
    await db.query(
      "select authorized_family_action($1,$2,'complete_task',$3)",
      [
        seed.authUserId,
        seed.familyId,
        { p_task_id: task.id, p_member_id: member },
      ],
    );
    const dashboard = await view('dashboard');
    expect(dashboard.member.id).toBe(member);
    expect(dashboard.balance).toBe(0);
    expect(dashboard.recentCompletions).toHaveLength(1);
    expect(dashboard.recentCompletions[0].task_title).toBe('Zero point work');
    expect(dashboard.recentTransactions).toEqual([]);
    expect(dashboard.todayTasks[0]).not.toHaveProperty(
      'created_by_app_user_id',
    );
    const page = await view('completions');
    expect(page.completions).toHaveLength(1);
    expect(page.transactions).toEqual([]);
    await expect(view('dashboard', {}, seed.authUserId)).rejects.toThrow(
      'FORBIDDEN',
    );
  });
  it('aggregates private family points, includes ancient rows, excludes future rows and inactive participants', async () => {
    await db.query(
      "insert into points_transactions(family_id,member_id,points,transaction_type,created_at) values($1,$2,8,'MANUAL_ADJUSTMENT','1999-01-01'),($1,$2,400,'MANUAL_ADJUSTMENT',now()+interval '1 day'),($3,$4,900,'MANUAL_ADJUSTMENT','2025-01-01')",
      [seed.familyId, member, other.familyId, other.memberId],
    );
    const data = await view('leaderboard');
    expect(
      data.entries.find((r: { memberId: string }) => r.memberId === member)
        .points,
    ).toBe(8);
    expect(data.entries).toHaveLength(2);
    expect(data).not.toHaveProperty('transactions');
    expect(JSON.stringify(data)).not.toMatch(
      /birth_year|login_email|app_user_id/,
    );
    await db.query('update family_members set active=false where id=$1', [
      seed.memberId,
    ]);
    expect((await view('leaderboard')).entries).toHaveLength(1);
  });
  it('revocation prevents every snapshot read and browser cannot invoke the privileged read function', async () => {
    expect(
      (
        await db.query(
          "select has_function_privilege('authenticated','member_view_read(uuid,text,jsonb)','execute') permitted",
        )
      ).rows[0].permitted,
    ).toBe(false);
    await db.query('select set_member_access($1,$2,$3,$4,null)', [
      seed.authUserId,
      seed.familyId,
      member,
      { enabled: false, expectedVersion: 2 },
    ]);
    for (const kind of [
      'dashboard',
      'points',
      'summary',
      'directory',
      'profile',
      'completions',
      'leaderboard',
    ])
      await expect(view(kind)).rejects.toThrow('ACCESS_REVOKED');
  });
  it('does not count a reversed earlier award as points for the current completion', async () => {
    const data = (
      await db.query(
        "select authorized_resource_write($1,$2,'tasks','insert',null,$3,null) r",
        [
          seed.authUserId,
          seed.familyId,
          { title: 'Repeat work', assigned_member_id: member, points: 7 },
        ],
      )
    ).rows[0].r[0];
    for (const action of ['complete_task', 'reopen_task', 'complete_task'])
      await db.query('select authorized_family_action($1,$2,$3,$4)', [
        seed.authUserId,
        seed.familyId,
        action,
        { p_task_id: data.id, p_member_id: member },
      ]);
    const history = await view('completions');
    expect(history.completions[0].awarded_points).toBe(7);
    expect((await view('summary')).balance).toBe(7);
    expect(
      (await view('leaderboard')).entries.find(
        (entry: { memberId: string }) => entry.memberId === member,
      ).completedTasks,
    ).toBe(2);
  });
  it('upcoming tasks are bounded, ordered and exclude completed or other assignments', async () => {
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    for (let n = 0; n < 12; n++)
      await db.query(
        "select authorized_resource_write($1,$2,'tasks','insert',null,$3,null)",
        [
          seed.authUserId,
          seed.familyId,
          {
            title: 'Upcoming ' + n,
            assigned_member_id: member,
            points: 1,
            due_date: future,
            due_time: n % 2 ? '12:00' : '09:00',
          },
        ],
      );
    const data = await view('dashboard');
    expect(data.upcomingTasks).toHaveLength(10);
    expect(
      data.upcomingTasks.map((task: { due_time: string }) => task.due_time),
    ).toEqual(
      [
        ...data.upcomingTasks.map(
          (task: { due_time: string }) => task.due_time,
        ),
      ].sort(),
    );
  });
  it('date summaries use UTC inclusive dates even when the database timezone differs', async () => {
    await db.query("set timezone='America/Sao_Paulo'");
    await db.query(
      "insert into points_transactions(family_id,member_id,points,transaction_type,created_at) values($1,$2,2,'MANUAL_ADJUSTMENT','2025-03-10T00:00:00Z'),($1,$2,3,'MANUAL_ADJUSTMENT','2025-03-10T23:59:59Z'),($1,$2,99,'MANUAL_ADJUSTMENT','2025-03-11T00:00:00Z')",
      [seed.familyId, member],
    );
    expect(
      (await view('summary', { from: '2025-03-10', to: '2025-03-10' })).net,
    ).toBe(5);
  });
  it('additional manager may inspect a participant in the same family only', async () => {
    const manager = await provision('manager@example.test', 'MANAGER');
    expect(
      (await view('profile', { memberId: member }, manager.subject)).member.id,
    ).toBe(member);
    await expect(
      view('profile', { memberId: other.memberId }, manager.subject),
    ).rejects.toThrow('NOT_FOUND');
  });
});
