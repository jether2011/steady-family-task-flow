/**
 * DB-backed property test — complete → reopen → complete (task 7.7).
 *
 * **Feature: family-task-board-backend, Property 6: Complete → reopen →
 * complete yields a single net positive award.**
 *
 * **Validates: Requirements 11.7**
 *
 * ----------------------------------------------------------------------------
 * What this proves
 * ----------------------------------------------------------------------------
 * R11.7 says a reopened task can be completed AGAIN: reopening flips the task
 * back to TODO which deletes its single `task_completions` row and so re-arms
 * the `UNIQUE(task_id)` constraint, letting `complete_task` insert a fresh
 * completion. This test drives the real atomic RPCs against a REAL Postgres —
 * `complete_task` → `reopen_task` → `complete_task` — for a task worth `P`
 * points (P unchanged across the whole cycle) and asserts the end state:
 *
 *   1. The task is DONE again after the second completion.
 *   2. There is EXACTLY ONE `task_completions` row for the task (the first was
 *      deleted on reopen; the second re-created it).
 *   3. The task's net ledger contribution is a SINGLE award of P. The ledger is
 *      append-only, so three rows exist for a positive task:
 *         TASK_COMPLETION(+P), REVERSAL(-P), TASK_COMPLETION(+P)
 *      whose SUM is exactly P. A 0-point task writes NO ledger rows at all and
 *      nets 0 while still ending DONE. Either way `sum(points) == P`.
 *
 * This exercises `complete_task` + `reopen_task` + `complete_task` end to end,
 * confirming re-completion is allowed (R11.7) and nets to exactly one award.
 *
 * ----------------------------------------------------------------------------
 * auth.* SHIM + GUARD
 * ----------------------------------------------------------------------------
 * Like migrations.test.ts, this applies a minimal `auth` schema + pgcrypto +
 * Supabase roles shim before the migrations so the Supabase-targeted DDL
 * applies on a bare Postgres (those objects are platform-provided in real
 * Supabase). The suite needs a reachable Postgres via TEST_DATABASE_URL
 * (fallback DATABASE_URL); when neither is set it SKIPS gracefully so the
 * default `npm test` stays green in environments without a database.
 *
 * Run count: 30 DB-backed fast-check runs (within the 25–50 band). Each run
 * seeds a family + active member + a non-DONE task worth a generated P, runs
 * the full cycle, asserts the invariants, then resets the per-run state
 * (completions, ledger, task) so runs are independent.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';

const CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

const HAS_DB = CONNECTION_STRING.length > 0;

const here = dirname(fileURLToPath(import.meta.url));
const SUPABASE_DIR = join(here, '..', '..', 'src', 'supabase');
const MIGRATIONS_DIR = join(SUPABASE_DIR, 'migrations');

// 30 DB-backed runs — comfortably inside the requested 25–50 band while
// keeping total round trips to the throwaway Postgres bounded.
const NUM_RUNS = 30;

// Migrations applied in strict order (same set the migration test applies).
const MIGRATION_FILES = [
  '001_initial_schema.sql',
  '002_indexes.sql',
  '003_rls.sql',
  '004_functions.sql',
  '005_realtime.sql',
  '006_update_family.sql',
] as const;

// Minimal auth.* shim: on real Supabase these objects are provided by the
// platform; a bare Postgres needs them before 001 can apply. Kept identical in
// spirit to migrations.test.ts so both integration suites share one approach.
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

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn(
    '[complete-reopen-complete.property.test] SKIPPED: no TEST_DATABASE_URL / ' +
      'DATABASE_URL set. Set TEST_DATABASE_URL to a reachable Postgres to run ' +
      'the complete→reopen→complete property test (e.g. a disposable ' +
      '`docker run postgres`).',
  );
}

// describe.skip when there is no database, so the rest of `npm test` stays green.
const suite = HAS_DB ? describe : describe.skip;

suite(
  'Feature: family-task-board-backend, Property 6: Complete → reopen → complete yields a single net positive award',
  () => {
    // `pg` is only required inside the guarded suite so that environments
    // without the dependency (and without a DB) are unaffected.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let client: any;

    // Stable identities seeded once; the per-run task is created/reset inside
    // each property iteration so runs stay independent.
    let authUserId: string;
    let responsibleUserId: string;
    let familyId: string;
    let memberId: string;

    async function readSql(file: string): Promise<string> {
      return readFile(join(MIGRATIONS_DIR, file), 'utf8');
    }

    beforeAll(async () => {
      const { Client } = await import('pg');
      client = new Client({ connectionString: CONNECTION_STRING });
      await client.connect();

      // Clean slate so repeated runs are deterministic.
      await client.query('drop schema if exists public cascade');
      await client.query('create schema public');
      await client.query('drop schema if exists auth cascade');

      // 1) auth.* + pgcrypto shim BEFORE any migration.
      await client.query(AUTH_SHIM_SQL);

      // 2) apply every migration in order.
      for (const file of MIGRATION_FILES) {
        await client.query(await readSql(file));
      }

      // 3) seed the fixed identities the RPCs reference. The RPC preconditions
      //    (family ownership, member active) are enforced by the backend
      //    service in production; here we seed a valid active member and a
      //    task in the same family so the RPCs operate on consistent data.
      const auth = await client.query(
        `insert into auth.users (email) values ('p6@example.test') returning id`,
      );
      authUserId = auth.rows[0].id;

      const resp = await client.query(
        `insert into responsible_users (auth_user_id, name, relationship)
         values ($1, 'P6 Responsible', 'MOTHER') returning id`,
        [authUserId],
      );
      responsibleUserId = resp.rows[0].id;

      const fam = await client.query(
        `insert into families (responsible_user_id, name)
         values ($1, 'P6 Family') returning id`,
        [responsibleUserId],
      );
      familyId = fam.rows[0].id;

      const member = await client.query(
        `insert into family_members (family_id, name, member_type, active)
         values ($1, 'P6 Child', 'CHILD', true) returning id`,
        [familyId],
      );
      memberId = member.rows[0].id;
    }, 60_000);

    afterAll(async () => {
      if (client) {
        await client.end();
      }
    });

    /**
     * Create a fresh non-DONE task worth `points` in the seeded family and
     * return its id. A new task per run means the per-run state is isolated.
     */
    async function createTask(points: number): Promise<string> {
      const res = await client.query(
        `insert into tasks
           (family_id, title, created_by_user_id, status, points)
         values ($1, 'P6 Task', $2, 'TODO', $3)
         returning id`,
        [familyId, responsibleUserId, points],
      );
      return res.rows[0].id as string;
    }

    /** Current status of a task. */
    async function taskStatus(taskId: string): Promise<string> {
      const res = await client.query(
        `select status from tasks where id = $1`,
        [taskId],
      );
      return res.rows[0].status as string;
    }

    /** Number of task_completions rows for a task. */
    async function completionCount(taskId: string): Promise<number> {
      const res = await client.query(
        `select count(*)::int as n from task_completions where task_id = $1`,
        [taskId],
      );
      return res.rows[0].n as number;
    }

    /** Signed sum of all ledger rows for a task (null-safe → 0 when none). */
    async function ledgerSum(taskId: string): Promise<number> {
      const res = await client.query(
        `select coalesce(sum(points), 0)::int as s
           from points_transactions where task_id = $1`,
        [taskId],
      );
      return res.rows[0].s as number;
    }

    /** Count of ledger rows for a task (0-point tasks write none). */
    async function ledgerRowCount(taskId: string): Promise<number> {
      const res = await client.query(
        `select count(*)::int as n from points_transactions where task_id = $1`,
        [taskId],
      );
      return res.rows[0].n as number;
    }

    /** Remove all per-run state so the next iteration starts clean. */
    async function resetTask(taskId: string): Promise<void> {
      await client.query(`delete from points_transactions where task_id = $1`, [
        taskId,
      ]);
      await client.query(`delete from task_completions where task_id = $1`, [
        taskId,
      ]);
      await client.query(`delete from tasks where id = $1`, [taskId]);
    }

    it('complete→reopen→complete leaves the task DONE with one completion and a ledger sum of exactly P', async () => {
      await fc.assert(
        // Points space covers the two regimes the property distinguishes:
        // P === 0 (no ledger rows, nets 0) and P > 0 (three rows netting +P).
        fc.asyncProperty(fc.integer({ min: 0, max: 1000 }), async (points) => {
          const taskId = await createTask(points);
          try {
            // 1) First completion → DONE, one completion row, +P awarded.
            await client.query('select complete_task($1, $2, $3)', [
              taskId,
              memberId,
              responsibleUserId,
            ]);

            // 2) Reopen → TODO, completion removed, REVERSAL(-P) when P>0.
            await client.query('select reopen_task($1)', [taskId]);

            // The UNIQUE(task_id) constraint must be re-armed: zero completion
            // rows after reopen (R11.7 precondition for re-completion).
            expect(await completionCount(taskId)).toBe(0);

            // 3) Re-complete the reopened task → allowed (R11.7).
            await client.query('select complete_task($1, $2, $3)', [
              taskId,
              memberId,
              responsibleUserId,
            ]);

            // End state assertions.
            // R11.7: the task is DONE again.
            expect(await taskStatus(taskId)).toBe('DONE');

            // Exactly one completion row (first deleted on reopen, second
            // re-created) — UNIQUE(task_id) holds with a single live row.
            expect(await completionCount(taskId)).toBe(1);

            // Net ledger contribution is a SINGLE award of P:
            //   P>0 → +P -P +P == P across three rows;
            //   P===0 → no rows at all, sum 0.
            expect(await ledgerSum(taskId)).toBe(points);

            // Corroborate the regime: 0-point tasks write no ledger rows;
            // positive tasks write exactly the three cycle rows.
            expect(await ledgerRowCount(taskId)).toBe(points > 0 ? 3 : 0);
          } finally {
            await resetTask(taskId);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    }, 60_000);
  },
);
