/**
 * Dashboard + board aggregate integration tests (task 11.2).
 *
 * Feature: family-task-board-backend
 * Validates: Requirements 16.2, 16.3, 17.2, 17.3.
 *
 * ----------------------------------------------------------------------------
 * What this suite proves (and why it needs a real database)
 * ----------------------------------------------------------------------------
 * Task 11.1 built two read-model aggregates:
 *
 *   - `GET /family/dashboard` → `{ family, members(active), todayTasks, totals }`
 *     where `totals` is a per-member net balance summed from the ENTIRE
 *     Points_Ledger, and every piece of the payload is scoped to the caller's
 *     own family (R16.2, R16.3).
 *   - `GET /family/board?weekStart` → `{ weekStart, tasks, byDay, byStatus }`
 *     for the requested week, scoped to the caller's family (R17.3); a
 *     missing/malformed `weekStart` is rejected as `422 VALIDATION` by the
 *     route's `BoardQuery` schema before the service runs (R17.2).
 *
 * The two behaviours this file pins down — "dashboard totals EXACTLY equal the
 * sum of the family's ledger rows" and "no cross-family leakage of
 * members/tasks/totals" — are only meaningful against real rows: they are
 * assertions about how the service aggregates and family-scopes data that
 * actually lives in Postgres across TWO families. So, like the other DB
 * suites, this runs the real migrations through the shared `db-harness` and
 * seeds genuine rows; a mock could not falsify a scoping bug.
 *
 * ----------------------------------------------------------------------------
 * How the real service code is exercised without Supabase
 * ----------------------------------------------------------------------------
 * The dashboard/board SERVICE (`dashboard.service.ts`) holds the behaviour
 * under test — the ledger sum (`sumTotals`), the `byDay`/`byStatus` bucketing,
 * and the family-scoped composition. It reads through its repository, which in
 * production talks to Supabase/PostgREST — unreachable against the bare
 * Postgres the harness builds. We therefore mock ONLY the repository module
 * (`dashboard.repository.ts`) with `pg`-backed functions that issue the SAME
 * family-scoped queries the Supabase repository issues (keyed by `family_id`,
 * filtered by `due_date` / `week_start` / `active`, fetched by id). The real
 * service, the real DTO mapping, and the real `BoardQuery` Zod schema all run
 * unchanged — only the Supabase transport is swapped for a direct `pg` read
 * against the harness-seeded database.
 *
 * ----------------------------------------------------------------------------
 * GUARD / skip-without-DB
 * ----------------------------------------------------------------------------
 * Needs a reachable Postgres via TEST_DATABASE_URL (fallback DATABASE_URL).
 * When neither is set the suite SKIPS gracefully (describe.skip) so the default
 * `npm test` stays green in environments without a database. Schema setup and
 * reset are shared through ./db-harness; this file owns its own two-family
 * seed because the shared `seedFamily` only models a single family.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type PgClient,
  applySchema,
  connect,
  getConnectionString,
  hasDatabase,
  reset,
} from './db-harness.js';
import type {
  FamilyMemberRow,
  PointsTransactionRow,
  TaskRow,
} from '../../src/shared/types/index.js';

const HAS_DB = hasDatabase();

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn(
    '[dashboard-board.test] SKIPPED: no TEST_DATABASE_URL / DATABASE_URL set. ' +
      'Set TEST_DATABASE_URL to a reachable Postgres to run the dashboard + ' +
      'board aggregate integration tests (e.g. a disposable `docker run postgres`).',
  );
}

const suite = HAS_DB ? describe : describe.skip;

/* ------------------------------------------------------------------------- *
 * Repository mock
 * ------------------------------------------------------------------------- *
 * The mock reads from a `pg` pool against the SAME database the suite seeds.
 * `vi.mock` is hoisted above the imports, so the factory cannot close over a
 * `beforeAll` variable directly; instead it reads a module-level holder that
 * `beforeAll` populates once the pool is connected. Every function below
 * mirrors the exact scoping its Supabase counterpart applies in
 * dashboard.repository.ts.
 */
const mockState: { pool: PgClient | undefined } = { pool: undefined };

/**
 * Guard that the mocked repository has a live pool (set in beforeAll).
 *
 * A `pg` POOL (not a single Client) backs the mock reads: the real
 * `dashboard()` service fires its four repository calls concurrently via
 * `Promise.all`, and a single `pg.Client` cannot run overlapping queries. A
 * pool hands each concurrent read its own connection, matching how the
 * production Supabase client issues independent HTTP requests.
 */
function db(): PgClient {
  if (!mockState.pool) {
    throw new Error('mock pg pool not initialised');
  }
  return mockState.pool;
}

vi.mock(
  '../../src/modules/dashboard/dashboard.repository.js',
  () => ({
    // Mirrors family.repository.loadFamilyAndResponsible: fetch the household
    // row by id and the responsible-user row by id (both single rows).
    loadFamilyAndResponsible: async (
      familyId: string,
      responsibleUserId: string,
    ) => {
      const fam = await db().query(
        `select id, responsible_user_id, name, avatar_url, created_at, updated_at
           from families where id = $1`,
        [familyId],
      );
      const resp = await db().query(
        `select id, auth_user_id, name, email, avatar_url, relationship,
                created_at, updated_at
           from responsible_users where id = $1`,
        [responsibleUserId],
      );
      return { family: fam.rows[0], responsible: resp.rows[0] };
    },

    // Mirrors gamification.repository.listActiveMembers: ACTIVE roster only,
    // strictly family-scoped, ordered by created_at.
    listActiveMembers: async (familyId: string): Promise<FamilyMemberRow[]> => {
      const res = await db().query(
        `select id, family_id, name, member_type, avatar_url, color,
                birth_year, active, created_at, updated_at
           from family_members
          where family_id = $1 and active = true
          order by created_at asc`,
        [familyId],
      );
      return res.rows as FamilyMemberRow[];
    },

    // Mirrors dashboard.repository.listTasksByDueDate: family-scoped tasks for
    // a single due_date, ordered by created_at.
    listTasksByDueDate: async (
      familyId: string,
      dueDate: string,
    ): Promise<TaskRow[]> => {
      const res = await db().query(
        `select id, family_id, template_id, title, description,
                assigned_member_id, created_by_user_id, status, priority, points,
                due_date, due_time, week_start, carried_from_task_id,
                created_at, updated_at
           from tasks
          where family_id = $1 and due_date = $2
          order by created_at asc`,
        [familyId, dueDate],
      );
      return res.rows as TaskRow[];
    },

    // Mirrors dashboard.repository.listTasksByWeekStart: family-scoped tasks
    // for a single week_start, ordered by created_at.
    listTasksByWeekStart: async (
      familyId: string,
      weekStart: string,
    ): Promise<TaskRow[]> => {
      const res = await db().query(
        `select id, family_id, template_id, title, description,
                assigned_member_id, created_by_user_id, status, priority, points,
                due_date, due_time, week_start, carried_from_task_id,
                created_at, updated_at
           from tasks
          where family_id = $1 and week_start = $2
          order by created_at asc`,
        [familyId, weekStart],
      );
      return res.rows as TaskRow[];
    },

    // Mirrors dashboard.repository.listAllPoints: EVERY ledger row of the
    // family (no member/date filter), strictly family-scoped.
    listAllPoints: async (
      familyId: string,
    ): Promise<PointsTransactionRow[]> => {
      const res = await db().query(
        `select id, family_id, member_id, task_id, points, transaction_type,
                created_at
           from points_transactions
          where family_id = $1`,
        [familyId],
      );
      return res.rows as PointsTransactionRow[];
    },
  }),
);

// Imported AFTER vi.mock so the service binds to the mocked repository, and so
// the real BoardQuery schema + real service composition are what run.
const { board, dashboard } = await import(
  '../../src/modules/dashboard/dashboard.service.js'
);
const { BoardQuery } = await import(
  '../../src/modules/dashboard/dashboard.schemas.js'
);

/* ------------------------------------------------------------------------- *
 * Local two-family seed helpers (the shared harness only models one family)  *
 * ------------------------------------------------------------------------- */

interface SeededFamilyGraph {
  responsibleUserId: string;
  familyId: string;
}

/** Insert an auth user + responsible user + family. Returns the ids. */
async function seedFamilyGraph(
  client: PgClient,
  label: string,
): Promise<SeededFamilyGraph> {
  const auth = await client.query(
    `insert into auth.users (email) values ($1) returning id`,
    [`${label}@example.test`],
  );
  const authUserId = auth.rows[0].id as string;

  const resp = await client.query(
    `insert into responsible_users (auth_user_id, name, email, relationship)
       values ($1, $2, $3, 'MOTHER') returning id`,
    [authUserId, `${label} Owner`, `${label}@example.test`],
  );
  const responsibleUserId = resp.rows[0].id as string;

  const fam = await client.query(
    `insert into families (responsible_user_id, name)
       values ($1, $2) returning id`,
    [responsibleUserId, `${label} Family`],
  );
  const familyId = fam.rows[0].id as string;

  return { responsibleUserId, familyId };
}

/** Insert one family member (active by default) and return its id. */
async function seedMember(
  client: PgClient,
  familyId: string,
  opts: { name?: string; active?: boolean } = {},
): Promise<string> {
  const res = await client.query(
    `insert into family_members (family_id, name, member_type, active)
       values ($1, $2, 'CHILD', $3) returning id`,
    [familyId, opts.name ?? 'Kid', opts.active ?? true],
  );
  return res.rows[0].id as string;
}

/** Insert one task and return its id. */
async function seedTaskRow(
  client: PgClient,
  graph: SeededFamilyGraph,
  opts: {
    status?: string;
    points?: number;
    dueDate?: string | null;
    weekStart?: string | null;
    assignedMemberId?: string | null;
    title?: string;
  } = {},
): Promise<string> {
  const res = await client.query(
    `insert into tasks
       (family_id, title, created_by_user_id, status, points, due_date,
        week_start, assigned_member_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      graph.familyId,
      opts.title ?? 'A chore',
      graph.responsibleUserId,
      opts.status ?? 'TODO',
      opts.points ?? 0,
      opts.dueDate ?? null,
      opts.weekStart ?? null,
      opts.assignedMemberId ?? null,
    ],
  );
  return res.rows[0].id as string;
}

/** Insert one ledger row for a member. */
async function seedLedger(
  client: PgClient,
  graph: SeededFamilyGraph,
  memberId: string,
  points: number,
  transactionType = 'MANUAL_ADJUSTMENT',
): Promise<void> {
  await client.query(
    `insert into points_transactions
       (family_id, member_id, task_id, points, transaction_type)
     values ($1, $2, null, $3, $4)`,
    [graph.familyId, memberId, points, transactionType],
  );
}

suite('dashboard + board aggregates (R16.2/R16.3/R17.2/R17.3)', () => {
  let client: PgClient;

  // Pool backing the mocked repository's concurrent reads (see `db()`).
  let pool: PgClient;

  beforeAll(async () => {
    const pg = await import('pg');

    // Match PostgREST's wire behaviour: it returns `date` columns as plain
    // `YYYY-MM-DD` strings, which the service buckets `byDay` by. Node-postgres
    // would otherwise parse OID 1082 (`date`) into a local-time `Date` object,
    // so `task.due_date` would be a `Date` rather than the ISO string the real
    // repository yields. Register a passthrough parser so the mocked `pg` reads
    // return the same string shape as the production Supabase client.
    const DATE_OID = 1082;
    pg.types.setTypeParser(DATE_OID, (value: string) => value);

    // Single client owns schema setup + seeding (serial, deterministic).
    client = await connect();
    await applySchema(client);

    // Pool serves the mocked repository so the service's `Promise.all` reads
    // run on separate connections.
    pool = new pg.Pool({ connectionString: getConnectionString() });
    mockState.pool = pool;
  }, 120_000);

  afterAll(async () => {
    mockState.pool = undefined;
    if (pool) {
      await pool.end();
    }
    if (client) {
      await client.end();
    }
  });

  // Fresh, deterministic state per test so counts/sums are unambiguous.
  beforeEach(async () => {
    await reset(client);
  });

  // ===========================================================================
  // R16.3 — dashboard totals are EXACTLY the per-member sum of the family's
  // ledger rows, across every transaction type (adds and subtracts), with
  // active members zero-filled when they have no rows.
  // ===========================================================================
  it('dashboard totals equal the per-member sum of the ledger (R16.3)', async () => {
    const graph = await seedFamilyGraph(client, 'alpha');
    const alice = await seedMember(client, graph.familyId, { name: 'Alice' });
    const bob = await seedMember(client, graph.familyId, { name: 'Bob' });
    const carol = await seedMember(client, graph.familyId, { name: 'Carol' });

    // Alice: +50 (completion) +20 (manual) -30 (redemption) = net 40.
    await seedLedger(client, graph, alice, 50, 'TASK_COMPLETION');
    await seedLedger(client, graph, alice, 20, 'MANUAL_ADJUSTMENT');
    await seedLedger(client, graph, alice, -30, 'REDEMPTION');
    // Bob: +10 (completion) -10 (reversal) = net 0 (but present, not absent).
    await seedLedger(client, graph, bob, 10, 'TASK_COMPLETION');
    await seedLedger(client, graph, bob, -10, 'REVERSAL');
    // Carol: no ledger rows at all → must appear as 0 (zero-filled).

    const payload = await dashboard({
      familyId: graph.familyId,
      responsibleUserId: graph.responsibleUserId,
    });

    // Totals equal the independent SQL sum of each member's ledger rows.
    for (const memberId of [alice, bob, carol]) {
      const res = await client.query(
        `select coalesce(sum(points), 0)::int as total
           from points_transactions
          where family_id = $1 and member_id = $2`,
        [graph.familyId, memberId],
      );
      const expected = res.rows[0].total as number;
      expect(payload.totals[memberId]).toBe(expected);
    }

    // Spelled out for clarity.
    expect(payload.totals[alice]).toBe(40);
    expect(payload.totals[bob]).toBe(0);
    expect(payload.totals[carol]).toBe(0);

    // The totals map contains EXACTLY the three active members (no extras).
    expect(Object.keys(payload.totals).sort()).toEqual(
      [alice, bob, carol].sort(),
    );

    // And the whole-family total equals the sum of every ledger row.
    const familySum = await client.query(
      `select coalesce(sum(points), 0)::int as total
         from points_transactions where family_id = $1`,
      [graph.familyId],
    );
    const totalsSum = Object.values(payload.totals).reduce((a, b) => a + b, 0);
    expect(totalsSum).toBe(familySum.rows[0].total);
  });

  // ===========================================================================
  // R16.2 — the dashboard includes ONLY the caller's own-family data: a second
  // family's members, tasks, and ledger rows never leak into members,
  // todayTasks, or totals.
  // ===========================================================================
  it('dashboard includes only the caller own-family data — no cross-family leakage (R16.2)', async () => {
    const today = '2024-06-01';
    const now = new Date(`${today}T12:00:00Z`);

    // Family A (the caller).
    const a = await seedFamilyGraph(client, 'own');
    const aMember = await seedMember(client, a.familyId, { name: 'A-Kid' });
    const aInactive = await seedMember(client, a.familyId, {
      name: 'A-Gone',
      active: false,
    });
    const aTodayTask = await seedTaskRow(client, a, {
      title: 'A today',
      dueDate: today,
      assignedMemberId: aMember,
    });
    await seedTaskRow(client, a, { title: 'A other day', dueDate: '2024-05-20' });
    await seedLedger(client, a, aMember, 100, 'TASK_COMPLETION');

    // Family B (a stranger) — richly populated so leakage would be obvious.
    const b = await seedFamilyGraph(client, 'other');
    const bMember = await seedMember(client, b.familyId, { name: 'B-Kid' });
    await seedTaskRow(client, b, {
      title: 'B today',
      dueDate: today,
      assignedMemberId: bMember,
    });
    await seedLedger(client, b, bMember, 999, 'TASK_COMPLETION');

    const payload = await dashboard(
      { familyId: a.familyId, responsibleUserId: a.responsibleUserId },
      now,
    );

    // family block is family A's.
    expect(payload.family.id).toBe(a.familyId);
    expect(payload.family.name).toBe('own Family');

    // members: only family A's ACTIVE roster — the inactive A member and ALL of
    // family B's members are excluded (R16.1 active-only + R16.2 scoping).
    const memberIds = payload.members.map((m) => m.id);
    expect(memberIds).toContain(aMember);
    expect(memberIds).not.toContain(aInactive);
    expect(memberIds).not.toContain(bMember);
    expect(payload.members.every((m) => m.family_id === a.familyId)).toBe(true);

    // todayTasks: only family A's today task — B's same-day task never leaks.
    const taskIds = payload.todayTasks.map((t) => t.id);
    expect(taskIds).toEqual([aTodayTask]);
    expect(payload.todayTasks.every((t) => t.family_id === a.familyId)).toBe(
      true,
    );

    // totals: only family A's member keys, and B's 999 never contributes.
    expect(Object.keys(payload.totals)).toEqual([aMember]);
    expect(payload.totals[aMember]).toBe(100);
    expect(payload.totals[bMember]).toBeUndefined();
  });

  // ===========================================================================
  // R17.2 — a missing or malformed weekStart is rejected by the route schema
  // (surfaces as 422 VALIDATION) before the service runs.
  // ===========================================================================
  it('board weekStart validation: missing/malformed rejected, valid accepted (R17.2)', () => {
    // Missing entirely → fails (required).
    expect(BoardQuery.safeParse({}).success).toBe(false);

    // Malformed shapes → fail (not a real YYYY-MM-DD calendar date).
    for (const bad of [
      '',
      'not-a-date',
      '2024-13-01', // month 13
      '2024-02-30', // Feb 30 does not exist
      '06-01-2024', // wrong order
      '2024/06/01', // wrong separator
      '2024-6-1', // not zero-padded
    ]) {
      expect(
        BoardQuery.safeParse({ weekStart: bad }).success,
        `"${bad}" must be rejected`,
      ).toBe(false);
    }

    // An unexpected extra key is rejected (.strict() forbids e.g. familyId).
    expect(
      BoardQuery.safeParse({ weekStart: '2024-06-03', familyId: 'x' }).success,
    ).toBe(false);

    // A real ISO date is accepted and parsed through unchanged.
    const ok = BoardQuery.safeParse({ weekStart: '2024-06-03' });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.weekStart).toBe('2024-06-03');
    }
  });

  // ===========================================================================
  // R17.3 — the board returns only the caller's own-family tasks for the week,
  // and buckets them correctly by day and status. A non-Monday weekStart is
  // handled by matching whatever stored week_start equals it.
  // ===========================================================================
  it('board returns only own-family tasks for the week, bucketed by day and status (R17.3)', async () => {
    const weekStart = '2024-06-03'; // a Monday

    const a = await seedFamilyGraph(client, 'own');
    const b = await seedFamilyGraph(client, 'other');

    // Family A: three in-week tasks + one in a different week (excluded).
    const aMon = await seedTaskRow(client, a, {
      title: 'A mon todo',
      status: 'TODO',
      weekStart,
      dueDate: '2024-06-03',
    });
    const aTue = await seedTaskRow(client, a, {
      title: 'A tue working',
      status: 'WORKING',
      weekStart,
      dueDate: '2024-06-04',
    });
    const aMonDone = await seedTaskRow(client, a, {
      title: 'A mon done',
      status: 'DONE',
      weekStart,
      dueDate: '2024-06-03',
    });
    await seedTaskRow(client, a, {
      title: 'A next week',
      status: 'TODO',
      weekStart: '2024-06-10',
      dueDate: '2024-06-10',
    });

    // Family B: an in-week task that must NEVER appear in A's board.
    const bMon = await seedTaskRow(client, b, {
      title: 'B mon',
      status: 'TODO',
      weekStart,
      dueDate: '2024-06-03',
    });

    const payload = await board(
      { familyId: a.familyId, responsibleUserId: a.responsibleUserId },
      weekStart,
    );

    expect(payload.weekStart).toBe(weekStart);

    // Only A's three in-week tasks; B's task and A's other-week task excluded.
    const taskIds = payload.tasks.map((t) => t.id).sort();
    expect(taskIds).toEqual([aMon, aTue, aMonDone].sort());
    expect(payload.tasks.every((t) => t.family_id === a.familyId)).toBe(true);
    expect(taskIds).not.toContain(bMon);

    // byDay buckets by due_date.
    expect(payload.byDay['2024-06-03']?.map((t) => t.id).sort()).toEqual(
      [aMon, aMonDone].sort(),
    );
    expect(payload.byDay['2024-06-04']?.map((t) => t.id)).toEqual([aTue]);
    // No day bucket for days without tasks.
    expect(payload.byDay['2024-06-05']).toBeUndefined();

    // byStatus always has all four columns; tasks land in the right lane.
    expect(Object.keys(payload.byStatus).sort()).toEqual(
      ['BACKLOG', 'DONE', 'TODO', 'WORKING'].sort(),
    );
    expect(payload.byStatus.TODO.map((t) => t.id)).toEqual([aMon]);
    expect(payload.byStatus.WORKING.map((t) => t.id)).toEqual([aTue]);
    expect(payload.byStatus.DONE.map((t) => t.id)).toEqual([aMonDone]);
    expect(payload.byStatus.BACKLOG).toEqual([]);
  });

  // ===========================================================================
  // R17.3 (non-Monday weekStart) — the board does not assume Monday; it buckets
  // whatever tasks carry a week_start equal to the requested value, including a
  // task with a null due_date (which stays in `tasks`/`byStatus` but has no day
  // bucket).
  // ===========================================================================
  it('board handles a non-Monday weekStart by matching stored week_start, null due_date omitted from byDay (R17.3)', async () => {
    const weekStart = '2024-06-05'; // deliberately a Wednesday

    const a = await seedFamilyGraph(client, 'own');

    const dated = await seedTaskRow(client, a, {
      title: 'dated',
      status: 'TODO',
      weekStart,
      dueDate: '2024-06-06',
    });
    const noDueDate = await seedTaskRow(client, a, {
      title: 'no due date',
      status: 'BACKLOG',
      weekStart,
      dueDate: null,
    });

    const payload = await board(
      { familyId: a.familyId, responsibleUserId: a.responsibleUserId },
      weekStart,
    );

    expect(payload.weekStart).toBe(weekStart);

    // Both in-week tasks are present regardless of the non-Monday start.
    expect(payload.tasks.map((t) => t.id).sort()).toEqual(
      [dated, noDueDate].sort(),
    );

    // byDay only buckets the dated task; the null-due_date task is omitted.
    expect(payload.byDay['2024-06-06']?.map((t) => t.id)).toEqual([dated]);
    const byDayIds = Object.values(payload.byDay).flat().map((t) => t.id);
    expect(byDayIds).not.toContain(noDueDate);

    // byStatus still includes the null-due_date task in its lane.
    expect(payload.byStatus.TODO.map((t) => t.id)).toEqual([dated]);
    expect(payload.byStatus.BACKLOG.map((t) => t.id)).toEqual([noDueDate]);
  });
});
