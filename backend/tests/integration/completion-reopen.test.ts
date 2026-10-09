/**
 * DB-level completion + reopen EXAMPLE integration tests (task 7.3, optional).
 *
 * Feature: family-task-board-backend
 * Validates: Requirements 9.2, 9.3, 10.3, 11.1, 11.3, 11.7.
 *
 * ----------------------------------------------------------------------------
 * Why this file exists alongside the property suites
 * ----------------------------------------------------------------------------
 * The property suites (7.4–7.7) already cover the atomic RPCs across many
 * generated point values:
 *   - completion-award.property.test.ts        → Property 2 (R8.x, R10.2–R10.6)
 *   - at-most-one-completion.property.test.ts  → Property 3 (R9.1–R9.4)
 *   - reopen-reversal.property.test.ts         → Property 5 (R11.1–R11.6/9/10)
 *   - complete-reopen-complete.property.test.ts→ Property 6 (R11.7)
 *
 * This file pins the SAME behaviours down as a handful of focused, readable
 * EXAMPLE cases — the exact edge scenarios the property generators cover
 * statistically but don't spell out as named examples. They run the real
 * `complete_task` / `reopen_task` plpgsql RPCs (migration 004_functions.sql)
 * against a REAL Postgres via the shared db-harness, because the atomicity, the
 * UNIQUE(task_id) backstop, and the "ledger row only when points > 0" rule are
 * database behaviour that cannot be exercised against a mock.
 *
 * The example cases:
 *   1. A 0-point completion creates NO ledger row but still flips the task to
 *      DONE and writes exactly one Task_Completion row (R10.3).
 *   2. Completing an already-DONE task raises TASK_ALREADY_COMPLETED and leaves
 *      exactly ONE ledger row — the rejected attempt adds nothing (R9.2/R9.3).
 *   3. Reopening a DONE task removes the Task_Completion, KEEPS the original
 *      TASK_COMPLETION ledger row, and appends a REVERSAL (R11.1/R11.3).
 *   4. After a reopen the task can be completed AGAIN (R11.7).
 *
 * ----------------------------------------------------------------------------
 * GUARD / skip-without-DB
 * ----------------------------------------------------------------------------
 * Needs a reachable Postgres via TEST_DATABASE_URL (fallback DATABASE_URL).
 * When neither is set the suite SKIPS gracefully (describe.skip) so the default
 * `npm test` stays green in environments without a database. Schema setup,
 * reset, and seeding are all shared through ./db-harness so this file owns only
 * the example assertions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

const HAS_DB = hasDatabase();

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn(
    '[completion-reopen.test] SKIPPED: no TEST_DATABASE_URL / DATABASE_URL ' +
      'set. Set TEST_DATABASE_URL to a reachable Postgres to run the ' +
      'completion + reopen example integration tests (e.g. a disposable ' +
      '`docker run postgres`).',
  );
}

const suite = HAS_DB ? describe : describe.skip;

/** The jsonb summary returned by the `complete_task` RPC. */
interface CompleteResult {
  status: string;
  completedAt: string;
  completedByMemberId: string;
  awarded: number;
}

/** The jsonb summary returned by the `reopen_task` RPC. */
interface ReopenResult {
  status: string;
  reversedPoints: number;
}

suite('completion + reopen — DB example cases (R9/R10/R11)', () => {
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

  // Fresh, deterministic state per example so row counts are unambiguous.
  beforeEach(async () => {
    await reset(client);
  });

  /** Run complete_task and return its typed jsonb summary. */
  async function complete(
    taskId: string,
    memberId: string,
    responsibleUserId: string,
  ): Promise<CompleteResult> {
    const res = await client.query(
      'select complete_task($1, $2, $3) as result',
      [taskId, memberId, responsibleUserId],
    );
    return res.rows[0].result as CompleteResult;
  }

  /** Run reopen_task and return its typed jsonb summary. */
  async function reopen(taskId: string): Promise<ReopenResult> {
    const res = await client.query('select reopen_task($1) as result', [
      taskId,
    ]);
    return res.rows[0].result as ReopenResult;
  }

  async function taskStatus(taskId: string): Promise<string> {
    const res = await client.query('select status from tasks where id = $1', [
      taskId,
    ]);
    return res.rows[0].status as string;
  }

  async function completionCount(taskId: string): Promise<number> {
    const res = await client.query(
      'select count(*)::int as n from task_completions where task_id = $1',
      [taskId],
    );
    return res.rows[0].n as number;
  }

  /** All ledger rows for a task, oldest first. */
  async function ledgerRows(
    taskId: string,
  ): Promise<Array<{ points: number; transaction_type: string; member_id: string }>> {
    const res = await client.query(
      `select points, transaction_type, member_id
         from points_transactions
        where task_id = $1
        order by created_at asc, id asc`,
      [taskId],
    );
    return res.rows;
  }

  // ===========================================================================
  // R10.3 — a 0-point completion creates NO ledger row but still records the
  // completion and flips the task to DONE.
  // ===========================================================================
  it('0-point completion writes no ledger row but still DONE + one completion (R10.3)', async () => {
    const seed: SeededFamily = await seedFamily(client, { memberActive: true });
    const taskId = await seedTask(client, seed, { points: 0, status: 'TODO' });

    const result = await complete(
      taskId,
      seed.memberId,
      seed.responsibleUserId,
    );

    // The RPC reports DONE with a 0 award.
    expect(result.status).toBe('DONE');
    expect(result.awarded).toBe(0);
    expect(result.completedByMemberId).toBe(seed.memberId);

    // The task is DONE and has exactly one Task_Completion row...
    expect(await taskStatus(taskId)).toBe('DONE');
    expect(await completionCount(taskId)).toBe(1);

    // ...but NO ledger row was created for a 0-point task (R10.3).
    expect(await ledgerRows(taskId)).toHaveLength(0);
  });

  // ===========================================================================
  // R9.2 / R9.3 — completing an already-DONE task raises
  // TASK_ALREADY_COMPLETED and the rejected attempt writes no extra ledger row.
  // ===========================================================================
  it('completing an already-DONE task is rejected and adds no extra ledger row (R9.2/R9.3)', async () => {
    const seed: SeededFamily = await seedFamily(client, { memberActive: true });
    const taskId = await seedTask(client, seed, { points: 40, status: 'TODO' });

    // First completion succeeds and writes exactly one TASK_COMPLETION row.
    await complete(taskId, seed.memberId, seed.responsibleUserId);
    expect(await taskStatus(taskId)).toBe('DONE');
    expect(await ledgerRows(taskId)).toHaveLength(1);

    // Second completion of the SAME (now DONE) task must be rejected with the
    // TASK_ALREADY_COMPLETED exception (R9.2).
    let rejected = false;
    try {
      await complete(taskId, seed.memberId, seed.responsibleUserId);
    } catch (err) {
      rejected = true;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('TASK_ALREADY_COMPLETED');
    }
    expect(rejected).toBe(true);

    // The transaction rolled back, so there is still exactly ONE completion row
    // and exactly ONE ledger row — the rejected attempt added nothing (R9.3).
    expect(await completionCount(taskId)).toBe(1);
    const ledger = await ledgerRows(taskId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.transaction_type).toBe('TASK_COMPLETION');
    expect(ledger[0]!.points).toBe(40);
  });

  // ===========================================================================
  // R11.1 / R11.3 — reopening a DONE task removes the Task_Completion, keeps
  // the original TASK_COMPLETION ledger row, and appends a REVERSAL.
  // ===========================================================================
  it('reopen removes the completion, retains the original award, adds a REVERSAL (R11.1/R11.3)', async () => {
    const seed: SeededFamily = await seedFamily(client, { memberActive: true });
    const taskId = await seedTask(client, seed, { points: 30, status: 'TODO' });

    // Complete, then reopen.
    await complete(taskId, seed.memberId, seed.responsibleUserId);
    expect(await completionCount(taskId)).toBe(1);

    const reopenResult = await reopen(taskId);

    // R11.1: the completion row is removed and the task is back to TODO.
    expect(reopenResult.status).toBe('TODO');
    expect(reopenResult.reversedPoints).toBe(30);
    expect(await taskStatus(taskId)).toBe('TODO');
    expect(await completionCount(taskId)).toBe(0);

    // R11.3: history is preserved — the ORIGINAL TASK_COMPLETION row remains
    // and a REVERSAL of -30 is appended, so the task nets to 0.
    const rows = await ledgerRows(taskId);
    const originals = rows.filter((r) => r.transaction_type === 'TASK_COMPLETION');
    const reversals = rows.filter((r) => r.transaction_type === 'REVERSAL');

    expect(originals).toHaveLength(1);
    expect(originals[0]!.points).toBe(30);
    expect(reversals).toHaveLength(1);
    expect(reversals[0]!.points).toBe(-30);
    expect(reversals[0]!.member_id).toBe(seed.memberId);

    const net = rows.reduce((sum, r) => sum + r.points, 0);
    expect(net).toBe(0);
  });

  // ===========================================================================
  // R11.7 — a reopened task can be completed AGAIN (reopen re-arms the
  // UNIQUE(task_id) backstop by deleting the single completion row).
  // ===========================================================================
  it('a reopened task can be completed again (R11.7)', async () => {
    const seed: SeededFamily = await seedFamily(client, { memberActive: true });
    const taskId = await seedTask(client, seed, { points: 25, status: 'TODO' });

    // complete → reopen → complete again.
    await complete(taskId, seed.memberId, seed.responsibleUserId);
    await reopen(taskId);

    // The second completion is allowed and succeeds.
    const second = await complete(
      taskId,
      seed.memberId,
      seed.responsibleUserId,
    );
    expect(second.status).toBe('DONE');
    expect(second.awarded).toBe(25);

    // DONE again with exactly one live completion row.
    expect(await taskStatus(taskId)).toBe('DONE');
    expect(await completionCount(taskId)).toBe(1);

    // The append-only ledger holds all three cycle rows:
    //   TASK_COMPLETION(+25), REVERSAL(-25), TASK_COMPLETION(+25) → net +25.
    const rows = await ledgerRows(taskId);
    expect(rows).toHaveLength(3);
    const net = rows.reduce((sum, r) => sum + r.points, 0);
    expect(net).toBe(25);
  });
});
