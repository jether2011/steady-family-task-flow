/**
 * Property 5 — Complete-then-reopen nets to zero and preserves history.
 *
 * Feature: family-task-board-backend, Property 5: Complete-then-reopen nets to
 * zero and preserves history.
 *
 * **Validates: Requirements 11.1, 11.2, 11.3, 11.5, 11.6, 11.9, 11.10**
 *
 * ----------------------------------------------------------------------------
 * What this exercises
 * ----------------------------------------------------------------------------
 * This is a DB-backed property test: it runs the REAL atomic RPCs
 * `complete_task` and `reopen_task` (from src/supabase/migrations/004_functions.sql)
 * against a REAL PostgreSQL instance, so the ledger invariants are checked
 * against the actual plpgsql transaction semantics and the UNIQUE(task_id)
 * backstop rather than a re-implementation.
 *
 * For each generated run we:
 *   1. Seed a family + one active family_member + one non-DONE task with a
 *      random non-negative points value P.
 *   2. complete_task(task, member) then reopen_task(task).
 *   3. Assert the Property 5 invariants:
 *        - the task_completions row for the task is REMOVED (R11.1);
 *        - the ORIGINAL TASK_COMPLETION ledger row is RETAINED (R11.3);
 *        - when P > 0, exactly one REVERSAL ledger row of -P exists and the
 *          RPC's returned reversedPoints == P (R11.2);
 *        - when P == 0, NO REVERSAL row is created and reversedPoints == 0
 *          (R11.5);
 *        - the net ledger contribution for the task (sum of ALL its ledger
 *          rows) is 0 (R11.1 / R11.6);
 *        - the task status is back to TODO (R11.1 / R11.6).
 *
 * Beyond the generated runs there are two explicit scenarios the generator
 * cannot reliably produce:
 *   - Negative-balance preservation (R11.10): a member is given a prior
 *     negative movement so that reversing their completion drives the DERIVED
 *     total below 0; we assert the REVERSAL is still recorded and the summed
 *     total is negative (the append-only audit trail is preserved, totals are
 *     not clamped).
 *   - Concurrency (R11.9): two reopen_task calls race on the same DONE task;
 *     we assert AT MOST ONE completion is removed and AT MOST ONE REVERSAL is
 *     created (one call wins, the other is a no-op / error).
 *
 * ----------------------------------------------------------------------------
 * Harness / GUARD
 * ----------------------------------------------------------------------------
 * The suite needs a reachable Postgres via TEST_DATABASE_URL (fallback
 * DATABASE_URL). When neither is set it SKIPS gracefully so the default
 * `npm test` stays green in environments without a database.
 *
 * The schema is built the same way migrations.test.ts builds it: a minimal
 * auth.* + roles + pgcrypto shim (Supabase provides these on the real platform;
 * a bare Postgres does not) is applied first, then migrations 001 -> 006 in
 * order. The RPCs are SECURITY DEFINER and the harness connects as the DB
 * owner, which bypasses RLS — so this test seeds rows directly and invokes the
 * ledger RPCs exactly as the service-role client does in production.
 *
 * db-harness note: if a parallel task adds tests/integration/db-harness.ts this
 * file deliberately does NOT depend on it (it is self-contained) so the two can
 * coexist without clobbering each other.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

const HAS_DB = CONNECTION_STRING.length > 0;

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', '..', 'src', 'supabase', 'migrations');

const MIGRATION_FILES = [
  '001_initial_schema.sql',
  '002_indexes.sql',
  '003_rls.sql',
  '004_functions.sql',
  '005_realtime.sql',
  '006_update_family.sql',
] as const;

// Minimal auth.* shim (same shape as migrations.test.ts): roles + pgcrypto +
// a stub auth schema so the migration DDL applies on a bare Postgres.
const AUTH_SHIM_SQL = `
  create extension if not exists pgcrypto;

  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      create role service_role nologin;
    end if;
  end
  $$;

  create schema if not exists auth;
  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    instance_id uuid,
    aud text,
    role text,
    email text,
    raw_app_meta_data jsonb,
    raw_user_meta_data jsonb,
    created_at timestamptz,
    updated_at timestamptz
  );
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select null::uuid $$;
`;

// Number of generated DB-backed property runs. Kept modest (each run performs
// several real round trips: seed + complete + reopen + assertion queries, all
// wrapped so state is reset between runs) so the suite stays well under the
// Vitest timeout while still exercising a broad spread of point values.
const NUM_RUNS = 30;

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn(
    '[reopen-reversal.property.test] SKIPPED: no TEST_DATABASE_URL / ' +
      'DATABASE_URL set. Point it at a reachable Postgres (e.g. a disposable ' +
      '`docker run postgres`) to run Property 5.',
  );
}

const suite = HAS_DB ? describe : describe.skip;

suite('Property 5: complete→reopen nets to zero & preserves history (R11)', () => {
  // `pg` is only imported inside the guarded suite so environments without the
  // dependency and without a DB are unaffected.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;

  // --- schema setup ---------------------------------------------------------
  beforeAll(async () => {
    const { Client } = await import('pg');
    client = new Client({ connectionString: CONNECTION_STRING });
    await client.connect();

    // Clean slate so repeated local runs are deterministic.
    await client.query('drop schema if exists public cascade');
    await client.query('create schema public');
    await client.query('drop schema if exists auth cascade');

    await client.query(AUTH_SHIM_SQL);

    for (const file of MIGRATION_FILES) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query(sql);
    }
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.end();
    }
  });

  // Reset all mutable data between runs/cases so each scenario starts clean
  // while keeping the (expensive) schema in place. TRUNCATE ... CASCADE clears
  // the whole ownership graph in one shot.
  async function resetData(): Promise<void> {
    await client.query(`
      truncate table
        points_transactions,
        task_completions,
        tasks,
        task_templates,
        family_members,
        families,
        responsible_users,
        awards
      restart identity cascade
    `);
    await client.query('delete from auth.users');
  }

  afterEach(async () => {
    await resetData();
  });

  // --- seed helpers ---------------------------------------------------------
  // Seed a family + active member + one non-DONE task worth `points`.
  // Returns the ids needed to drive and inspect the ledger.
  async function seedFamilyWithTask(
    points: number,
    status: 'BACKLOG' | 'TODO' | 'WORKING' = 'TODO',
  ): Promise<{ familyId: string; memberId: string; taskId: string; responsibleUserId: string }> {
    const authUser = await client.query(
      `insert into auth.users(email) values ('p5@example.test') returning id`,
    );
    const authUserId = authUser.rows[0].id as string;

    const ru = await client.query(
      `insert into responsible_users(auth_user_id, name, email, relationship)
         values ($1, 'P5 Parent', 'p5@example.test', 'MOTHER')
       returning id`,
      [authUserId],
    );
    const responsibleUserId = ru.rows[0].id as string;

    const fam = await client.query(
      `insert into families(responsible_user_id, name)
         values ($1, 'P5 Family') returning id`,
      [responsibleUserId],
    );
    const familyId = fam.rows[0].id as string;

    const mem = await client.query(
      `insert into family_members(family_id, name, member_type, active)
         values ($1, 'Kid', 'CHILD', true) returning id`,
      [familyId],
    );
    const memberId = mem.rows[0].id as string;

    const task = await client.query(
      `insert into tasks(family_id, created_by_user_id, title, status, points)
         values ($1, $2, 'Chore', $3, $4) returning id`,
      [familyId, responsibleUserId, status, points],
    );
    const taskId = task.rows[0].id as string;

    return { familyId, memberId, taskId, responsibleUserId };
  }

  // --- ledger inspection helpers -------------------------------------------
  async function ledgerRowsForTask(taskId: string): Promise<
    Array<{ points: number; transaction_type: string; member_id: string }>
  > {
    const res = await client.query(
      `select points, transaction_type, member_id
         from points_transactions
        where task_id = $1
        order by created_at asc, id asc`,
      [taskId],
    );
    return res.rows;
  }

  async function completionCountForTask(taskId: string): Promise<number> {
    const res = await client.query(
      `select count(*)::int as n from task_completions where task_id = $1`,
      [taskId],
    );
    return res.rows[0].n as number;
  }

  async function taskStatus(taskId: string): Promise<string> {
    const res = await client.query(`select status from tasks where id = $1`, [
      taskId,
    ]);
    return res.rows[0].status as string;
  }

  async function memberTotal(familyId: string, memberId: string): Promise<number> {
    const res = await client.query(
      `select coalesce(sum(points), 0)::int as total
         from points_transactions
        where family_id = $1 and member_id = $2`,
      [familyId, memberId],
    );
    return res.rows[0].total as number;
  }

  // ===========================================================================
  // Core property: for any non-negative P, complete-then-reopen nets to zero
  // and preserves the original TASK_COMPLETION row.
  // ===========================================================================
  it(
    'complete→reopen nets a task to zero and retains its history (R11.1/11.2/11.3/11.5/11.6)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // Random non-negative points, biased so both P>0 and the P==0 edge
          // (R11.5) are hit. Values span 0 up into realistic chore points.
          fc.oneof(
            { weight: 1, arbitrary: fc.constant(0) },
            { weight: 4, arbitrary: fc.integer({ min: 1, max: 500 }) },
          ),
          fc.constantFrom<'BACKLOG' | 'TODO' | 'WORKING'>('BACKLOG', 'TODO', 'WORKING'),
          async (points, startStatus) => {
            await resetData();
            const { familyId, memberId, taskId } = await seedFamilyWithTask(
              points,
              startStatus,
            );

            // complete
            const completeRes = await client.query(
              `select complete_task($1, $2, $3) as payload`,
              [taskId, memberId, (await responsibleUserIdFor(familyId))],
            );
            const completePayload = completeRes.rows[0].payload;
            expect(completePayload.status).toBe('DONE');
            expect(completePayload.awarded).toBe(points);
            // DONE and exactly one completion before reopen.
            expect(await taskStatus(taskId)).toBe('DONE');
            expect(await completionCountForTask(taskId)).toBe(1);

            // reopen
            const reopenRes = await client.query(
              `select reopen_task($1) as payload`,
              [taskId],
            );
            const reversedPoints = reopenRes.rows[0].payload.reversedPoints as number;

            // --- Assertions -------------------------------------------------
            // R11.1: Task_Completion row removed.
            expect(await completionCountForTask(taskId)).toBe(0);

            // R11.1 / R11.6: status back to TODO.
            expect(reopenRes.rows[0].payload.status).toBe('TODO');
            expect(await taskStatus(taskId)).toBe('TODO');

            const rows = await ledgerRowsForTask(taskId);
            const originals = rows.filter(
              (r) => r.transaction_type === 'TASK_COMPLETION',
            );
            const reversals = rows.filter(
              (r) => r.transaction_type === 'REVERSAL',
            );

            if (points > 0) {
              // R11.3: the original TASK_COMPLETION row is retained.
              expect(originals).toHaveLength(1);
              expect(originals[0]!.points).toBe(points);
              // R11.2: exactly one REVERSAL of -P, credited to the same member.
              expect(reversals).toHaveLength(1);
              expect(reversals[0]!.points).toBe(-points);
              expect(reversals[0]!.member_id).toBe(memberId);
              // R11.1: the RPC reports the reversed amount.
              expect(reversedPoints).toBe(points);
            } else {
              // R11.5: a 0-point completion creates NO ledger row at all, so
              // there is nothing to reverse and no REVERSAL is created.
              expect(originals).toHaveLength(0);
              expect(reversals).toHaveLength(0);
              expect(reversedPoints).toBe(0);
            }

            // R11.1 / R11.6: net ledger contribution for the task is 0 — either
            // because +P and -P cancel, or because there were no rows at all.
            const net = rows.reduce((sum, r) => sum + r.points, 0);
            expect(net).toBe(0);

            // The member's total contribution FROM THIS TASK is 0 too.
            expect(await memberTotal(familyId, memberId)).toBe(0);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    },
    120_000,
  );

  // Small helper used inside the property body to fetch the responsible user id
  // for the family just seeded (keeps the generator signature free of ids).
  async function responsibleUserIdFor(familyId: string): Promise<string> {
    const res = await client.query(
      `select responsible_user_id from families where id = $1`,
      [familyId],
    );
    return res.rows[0].responsible_user_id as string;
  }

  // ===========================================================================
  // R11.10: reversing can drive the member's DERIVED total negative, and the
  // reversal is STILL recorded — totals are never clamped.
  // ===========================================================================
  it('allows the derived member total to go negative and still records the reversal (R11.10)', async () => {
    await resetData();
    const P = 50;
    const { familyId, memberId, taskId, responsibleUserId } =
      await seedFamilyWithTask(P, 'TODO');

    // Give the member a prior NEGATIVE movement (e.g. an earlier redemption)
    // so that after reversing this task their net goes below 0.
    const priorNegative = -80;
    await client.query(
      `insert into points_transactions(family_id, member_id, task_id, points, transaction_type)
         values ($1, $2, null, $3, 'REDEMPTION')`,
      [familyId, memberId, priorNegative],
    );

    // complete (+50) then reopen (-50 reversal).
    await client.query(`select complete_task($1, $2, $3)`, [
      taskId,
      memberId,
      responsibleUserId,
    ]);
    const reopenRes = await client.query(`select reopen_task($1) as payload`, [
      taskId,
    ]);

    // The reversal exists.
    const reversals = (await ledgerRowsForTask(taskId)).filter(
      (r) => r.transaction_type === 'REVERSAL',
    );
    expect(reversals).toHaveLength(1);
    expect(reversals[0]!.points).toBe(-P);
    expect(reopenRes.rows[0].payload.reversedPoints).toBe(P);

    // Derived total = prior(-80) + completion(+50) + reversal(-50) = -80. It is
    // negative and recorded, not clamped at 0.
    const total = await memberTotal(familyId, memberId);
    expect(total).toBe(priorNegative);
    expect(total).toBeLessThan(0);
  });

  // ===========================================================================
  // R11.9: two concurrent reopens on the same DONE task → at most one
  // completion removed and at most one REVERSAL created (one call wins).
  // ===========================================================================
  it('serializes concurrent reopens: at most one reversal / one removal (R11.9)', async () => {
    await resetData();
    const P = 25;
    const { familyId, memberId, taskId, responsibleUserId } =
      await seedFamilyWithTask(P, 'TODO');

    await client.query(`select complete_task($1, $2, $3)`, [
      taskId,
      memberId,
      responsibleUserId,
    ]);
    expect(await completionCountForTask(taskId)).toBe(1);

    // Fire two reopen_task calls on SEPARATE connections so they genuinely race
    // on the task row's FOR UPDATE lock in the RPC. One commits a reversal; the
    // other finds the task is no longer DONE (NOT_DONE) and makes no change.
    const { Client } = await import('pg');
    const c1 = new Client({ connectionString: CONNECTION_STRING });
    const c2 = new Client({ connectionString: CONNECTION_STRING });
    await c1.connect();
    await c2.connect();

    try {
      const results = await Promise.allSettled([
        c1.query(`select reopen_task($1) as payload`, [taskId]),
        c2.query(`select reopen_task($1) as payload`, [taskId]),
      ]);

      // Exactly one call succeeds; the loser rejects (NOT_DONE) rather than
      // double-reversing.
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // Invariants regardless of scheduling:
      //   - completion removed exactly once (now 0, never negative).
      expect(await completionCountForTask(taskId)).toBe(0);
      //   - at most one REVERSAL exists.
      const reversals = (await ledgerRowsForTask(taskId)).filter(
        (r) => r.transaction_type === 'REVERSAL',
      );
      expect(reversals.length).toBeLessThanOrEqual(1);
      // With P>0 the winning reopen must have created exactly one reversal.
      expect(reversals.length).toBe(1);
      expect(reversals[0]!.points).toBe(-P);
      // Net for the task is still 0 (original +P and the single -P reversal).
      const net = (await ledgerRowsForTask(taskId)).reduce(
        (s, r) => s + r.points,
        0,
      );
      expect(net).toBe(0);
      expect(await taskStatus(taskId)).toBe('TODO');
    } finally {
      await c1.end();
      await c2.end();
    }
  });
});
