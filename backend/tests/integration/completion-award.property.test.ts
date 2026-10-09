/**
 * Property 2 — "Completion awards exactly the task's points, atomically,
 * crediting the supplied member" (task 7.4).
 *
 * Feature: family-task-board-backend
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 10.2, 10.3, 10.4, 10.5, 10.6.
 *
 * This property is about the ATOMIC `complete_task` plpgsql RPC in migration
 * 004_functions.sql — not the HTTP layer. The whole point of that function is
 * that the Task_Completion insert, the ledger insert, and the task status flip
 * commit or roll back together (R10.4/R10.5). You cannot meaningfully exercise
 * that against a mock, so this suite runs against a REAL Postgres with
 * migrations 001..006 applied via the shared db-harness.
 *
 * The property, for a generated (task points P >= 0, chosen active member M):
 *   - Seed a family + an active member M + a non-DONE task with points P.
 *   - Call complete_task(task_id, M, responsible_user_id).
 *   - Assert:
 *       * exactly one task_completions row for the task, with
 *         completed_by_user_id = responsible (R8.3) and
 *         completed_by_member_id = M (R8.4),
 *       * the task status is DONE (R8.1),
 *       * when P > 0: exactly one TASK_COMPLETION ledger row of P for M,
 *         crediting the supplied member, so the ledger increased by exactly P
 *         (R10.2); when P = 0: NO ledger row was created (R10.3),
 *       * the returned jsonb `awarded` equals P (or 0) and `status` = DONE,
 *         `completedByMemberId` = M (R8.2),
 *       * `points` on the ledger row is derived from the stored task, never a
 *         request value (R10.6) — enforced because the RPC takes no points arg.
 *
 * ----------------------------------------------------------------------------
 * RUN COUNT
 * ----------------------------------------------------------------------------
 * Property-based tests usually run >= 100 cases, but every case here does a
 * full round trip to Postgres (truncate + several inserts + the RPC + several
 * verification queries). To keep the suite's wall-clock reasonable while still
 * covering a broad spread of point values, we run 30 cases (`NUM_RUNS`). The
 * points generator is biased to include the two behavioral boundaries that
 * matter — P = 0 (no ledger row) and P > 0 (exactly one ledger row) — on every
 * execution, so shrinking is cheap and the critical partitions are always hit.
 *
 * ----------------------------------------------------------------------------
 * GUARD
 * ----------------------------------------------------------------------------
 * Needs a reachable Postgres via TEST_DATABASE_URL (fallback DATABASE_URL).
 * When neither is set the suite SKIPS gracefully so the default `npm test`
 * stays green in environments without a database. Setup/reset/seed are shared
 * through ./db-harness so this file only owns the Property-2 assertions.
 */
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type PgClient,
  type SeededFamily,
  applySchema,
  connect,
  hasDatabase,
  reset,
  seedFamily,
  seedTask,
} from './db-harness.js';

const NUM_RUNS = 30;

const HAS_DB = hasDatabase();

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn(
    '[completion-award.property.test] SKIPPED: no TEST_DATABASE_URL / ' +
      'DATABASE_URL set. Set TEST_DATABASE_URL to a reachable Postgres to run ' +
      'the completion-award property test (e.g. a disposable `docker run postgres`).',
  );
}

const suite = HAS_DB ? describe : describe.skip;

suite(
  'Feature: family-task-board-backend, Property 2: Completion awards exactly ' +
    "the task's points, atomically, crediting the supplied member",
  () => {
    let client: PgClient;

    beforeAll(async () => {
      client = await connect();
      await applySchema(client);
    }, 120_000);

    afterAll(async () => {
      if (client) {
        await client.end();
      }
    });

    it('awards exactly P points atomically to the supplied member', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Points P >= 0. Bias toward 0 and small values so both behavioral
          // partitions (P = 0 → no ledger row; P > 0 → one ledger row) are hit
          // reliably, while still spanning a wide non-negative range.
          fc.oneof(
            { arbitrary: fc.constant(0), weight: 1 },
            { arbitrary: fc.integer({ min: 1, max: 10_000 }), weight: 3 },
          ),
          async (points) => {
            // Fresh state per case so counts/sums are unambiguous.
            await reset(client);

            // Seed a family + an active member M, then a non-DONE task worth P.
            const seed: SeededFamily = await seedFamily(client, {
              memberActive: true,
            });
            const { responsibleUserId, memberId } = seed;
            const taskId = await seedTask(client, seed, {
              points,
              status: 'TODO',
            });

            // Call the atomic RPC: complete_task(task_id, member_id, responsible_user_id).
            const rpc = await client.query(
              'select complete_task($1, $2, $3) as result',
              [taskId, memberId, responsibleUserId],
            );
            const result = rpc.rows[0].result as {
              status: string;
              completedByMemberId: string;
              awarded: number;
              completedAt: string;
            };

            // --- Returned jsonb summary (R8.2) ---
            expect(result.status).toBe('DONE');
            expect(result.completedByMemberId).toBe(memberId);
            expect(result.awarded).toBe(points);

            // --- Exactly one Task_Completion, correct actor + member (R8.3/R8.4) ---
            const completions = await client.query(
              `select completed_by_user_id, completed_by_member_id
                 from task_completions
                where task_id = $1`,
              [taskId],
            );
            expect(completions.rowCount).toBe(1);
            expect(completions.rows[0].completed_by_user_id).toBe(
              responsibleUserId,
            );
            expect(completions.rows[0].completed_by_member_id).toBe(memberId);

            // --- Task flipped to DONE (R8.1) ---
            const task = await client.query(
              'select status from tasks where id = $1',
              [taskId],
            );
            expect(task.rows[0].status).toBe('DONE');

            // --- Ledger behavior (R10.2 / R10.3 / R10.6) ---
            const ledger = await client.query(
              `select member_id, task_id, points, transaction_type
                 from points_transactions
                where task_id = $1`,
              [taskId],
            );

            if (points > 0) {
              // Exactly one TASK_COMPLETION row of exactly P, crediting M. The
              // points value is derived from the stored task (R10.6): the RPC
              // takes no points argument, so matching P proves the derivation.
              expect(ledger.rowCount).toBe(1);
              const row = ledger.rows[0];
              expect(row.transaction_type).toBe('TASK_COMPLETION');
              expect(row.member_id).toBe(memberId);
              expect(row.task_id).toBe(taskId);
              expect(row.points).toBe(points);

              // The member's derived total increased by exactly P (R10.2).
              const sum = await client.query(
                `select coalesce(sum(points), 0)::int as total
                   from points_transactions
                  where member_id = $1`,
                [memberId],
              );
              expect(sum.rows[0].total).toBe(points);
            } else {
              // P = 0: completion + DONE, but NO ledger row created (R10.3).
              expect(ledger.rowCount).toBe(0);
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    }, 120_000);
  },
);
