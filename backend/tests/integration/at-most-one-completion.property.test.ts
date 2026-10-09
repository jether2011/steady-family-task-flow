/**
 * Property-based integration test for duplicate-completion prevention (task 7.5).
 *
 * **Property 3: A task has at most one completion**
 *
 * **Validates: Requirements 9.1, 9.2, 9.3, 9.4**
 *
 * This property is NOT pure application logic — it is enforced by the database
 * itself: the `UNIQUE(task_id)` constraint on `task_completions` (R9.1) plus
 * the `SELECT ... FOR UPDATE` row lock and the `unique_violation` catch inside
 * the `complete_task` plpgsql RPC. So it can only be exercised against a REAL
 * PostgreSQL instance with the actual migrations applied. The suite therefore
 * runs the migrations (via the shared db-harness) against a disposable Postgres
 * and calls `complete_task` the same way the service-role client does.
 *
 * For every generated run (random point value) we assert, after a successful
 * completion followed by a second attempt on the SAME task:
 *   - the second attempt FAILS — the RPC raises `TASK_ALREADY_COMPLETED`
 *     (either because the task is already DONE, R9.2, or because the
 *     UNIQUE(task_id) insert is rejected). With the `pg` driver this surfaces
 *     as a rejected query, which we catch and inspect.
 *   - there is still EXACTLY ONE `task_completions` row for the task (R9.1).
 *   - there is AT MOST ONE `TASK_COMPLETION` ledger row for the task — no extra
 *     ledger entry is created by the rejected second attempt (R9.3). (Exactly
 *     one when points > 0; zero when points = 0, since a 0-point completion
 *     writes no ledger row — R10.3.)
 *
 * One run per property pass additionally covers the CONCURRENCY flavour (R9.4):
 * two `complete_task` calls for the same task are fired "concurrently" on two
 * SEPARATE `pg` clients via `Promise.all`. We assert exactly one succeeds and
 * one rejects, there is exactly one `task_completions` row, and at most one
 * `TASK_COMPLETION` ledger row. The `UNIQUE(task_id)` constraint plus the row
 * lock in the RPC are what make this deterministic.
 *
 * ----------------------------------------------------------------------------
 * Run count
 * ----------------------------------------------------------------------------
 * Each fast-check run performs several real round trips to Postgres (seed,
 * complete, duplicate attempt, counts, reset), and the concurrency pass opens
 * extra connections. To keep the suite fast while still sampling a meaningful
 * spread of point values we use a modest `numRuns` of 30 (within the 25–50
 * range the task calls for). The concurrency case runs once alongside the
 * property so its extra connection cost is paid a single time.
 *
 * ----------------------------------------------------------------------------
 * GUARD / skip-without-DB
 * ----------------------------------------------------------------------------
 * The suite needs a reachable Postgres via TEST_DATABASE_URL (fallback
 * DATABASE_URL). When neither is set it SKIPS gracefully (describe.skip) so the
 * default `npm test` stays green in environments without a database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  type PgClient,
  type SeededFamily,
  applySchema,
  connect,
  getConnectionString,
  hasDatabase,
  reset,
  seedFamily,
  seedTask,
} from './db-harness.js';

const HAS_DB = hasDatabase();

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn(
    '[at-most-one-completion.property.test] SKIPPED: no TEST_DATABASE_URL / ' +
      'DATABASE_URL set. Set TEST_DATABASE_URL to a reachable Postgres to run ' +
      'the duplicate-completion property test (e.g. a disposable ' +
      '`docker run postgres`).',
  );
}

const suite = HAS_DB ? describe : describe.skip;

/** Modest run count: each run makes several real DB round trips (task note). */
const NUM_RUNS = 30;

/** Count the task_completions rows for a task (expected: at most one — R9.1). */
async function countCompletions(
  client: PgClient,
  taskId: string,
): Promise<number> {
  const res = await client.query(
    `select count(*)::int as n from task_completions where task_id = $1`,
    [taskId],
  );
  return res.rows[0].n as number;
}

/**
 * Count the TASK_COMPLETION ledger rows for a task (R9.3): a rejected second
 * completion must add none, so this stays at exactly one when points > 0 and
 * zero when points = 0.
 */
async function countAwardLedgerRows(
  client: PgClient,
  taskId: string,
): Promise<number> {
  const res = await client.query(
    `select count(*)::int as n from points_transactions
       where task_id = $1 and transaction_type = 'TASK_COMPLETION'`,
    [taskId],
  );
  return res.rows[0].n as number;
}

/** True when a rejected RPC error is the named TASK_ALREADY_COMPLETED exception. */
function isAlreadyCompleted(err: unknown): boolean {
  return (
    err instanceof Error && /TASK_ALREADY_COMPLETED/.test(err.message)
  );
}

suite(
  'Feature: family-task-board-backend, Property 3: A task has at most one completion',
  () => {
    let client: PgClient;

    beforeAll(async () => {
      client = await connect();
      await applySchema(client);
    }, 60_000);

    afterAll(async () => {
      if (client) {
        await client.end();
      }
    });

    it(
      'a second completion of the same task is rejected and creates no extra ' +
        'completion or ledger row (R9.1, R9.2, R9.3)',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            // Random point value spanning the 0-point (no ledger row) and
            // positive (one ledger row) branches.
            fc.integer({ min: 0, max: 1000 }),
            async (points) => {
              await reset(client);
              const seed: SeededFamily = await seedFamily(client);
              const taskId = await seedTask(client, seed, { points });

              // First completion succeeds.
              await client.query(
                `select complete_task($1, $2, $3)`,
                [taskId, seed.memberId, seed.responsibleUserId],
              );

              // Second completion of the SAME task must be rejected.
              let secondRejected = false;
              try {
                await client.query(
                  `select complete_task($1, $2, $3)`,
                  [taskId, seed.memberId, seed.responsibleUserId],
                );
              } catch (err) {
                secondRejected = true;
                // The RPC raises TASK_ALREADY_COMPLETED (R9.2 already-DONE
                // path; UNIQUE(task_id) backstop otherwise).
                expect(isAlreadyCompleted(err)).toBe(true);
              }
              expect(secondRejected).toBe(true);

              // Exactly one completion row survives (R9.1).
              expect(await countCompletions(client, taskId)).toBe(1);

              // No extra ledger entry from the rejected attempt (R9.3):
              // one TASK_COMPLETION row when points > 0, zero when points = 0.
              const expectedLedger = points > 0 ? 1 : 0;
              expect(await countAwardLedgerRows(client, taskId)).toBe(
                expectedLedger,
              );
            },
          ),
          { numRuns: NUM_RUNS },
        );
      },
      120_000,
    );

    it(
      'two concurrent completions of the same task yield exactly one ' +
        'completion and at most one ledger row (R9.4)',
      async () => {
        // Fresh state and a positive-point task so a successful completion
        // writes exactly one TASK_COMPLETION ledger row.
        await reset(client);
        const seed = await seedFamily(client);
        const taskId = await seedTask(client, seed, { points: 50 });

        // Two SEPARATE connections so the calls genuinely race at the DB; the
        // UNIQUE(task_id) constraint + the FOR UPDATE row lock in the RPC make
        // exactly one win.
        const a = await connect();
        const b = await connect();
        try {
          const fire = (c: PgClient) =>
            c
              .query(`select complete_task($1, $2, $3)`, [
                taskId,
                seed.memberId,
                seed.responsibleUserId,
              ])
              .then(
                () => ({ ok: true as const }),
                (err: unknown) => ({ ok: false as const, err }),
              );

          const results = await Promise.all([fire(a), fire(b)]);

          const succeeded = results.filter((r) => r.ok);
          const failed = results.filter((r) => !r.ok);

          // Exactly one wins, exactly one loses.
          expect(succeeded).toHaveLength(1);
          expect(failed).toHaveLength(1);
          // The loser is reported as a duplicate completion (R9.4).
          const failure = failed[0] as { ok: false; err: unknown };
          expect(isAlreadyCompleted(failure.err)).toBe(true);

          // Exactly one completion row and at most one award ledger row.
          expect(await countCompletions(client, taskId)).toBe(1);
          expect(await countAwardLedgerRows(client, taskId)).toBe(1);
        } finally {
          await a.end();
          await b.end();
        }
      },
      60_000,
    );
  },
);
