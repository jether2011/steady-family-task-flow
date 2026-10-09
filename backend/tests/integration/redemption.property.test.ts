/**
 * Property 10 — "Redemption respects balance and records exactly the stored
 * cost" (task 10.5).
 *
 * Feature: family-task-board-backend, Property 10: Redemption respects balance
 * and records exactly the stored cost.
 *
 * **Validates: Requirements 18.5, 18.6, 18.7, 18.11**
 *
 * ----------------------------------------------------------------------------
 * What this exercises
 * ----------------------------------------------------------------------------
 * This is about the ATOMIC `redeem_award` plpgsql RPC in migration
 * 004_functions.sql — not the HTTP layer. The RPC reads `points_cost` from the
 * STORED award, computes the member's derived balance as the SUM of their
 * ledger rows, guards against overspend (`INSUFFICIENT_POINTS`), and inserts a
 * single REDEMPTION row of `-cost` — all in one implicit DB transaction, with a
 * `FOR UPDATE` lock on the member row serializing concurrent redemptions. None
 * of that can be exercised against a mock, so this suite runs against a REAL
 * Postgres with migrations 001..006 applied via the shared db-harness.
 *
 * The property, for a generated (starting balance B >= 0, award cost C >= 0):
 *   - Seed a family + one active member M.
 *   - Give M a starting balance B by inserting ledger rows directly (a
 *     MANUAL_ADJUSTMENT of B when B > 0; nothing when B = 0).
 *   - Create an award with a random `points_cost` C.
 *   - Call redeem_award(award_id, M, family_id) and observe success/failure.
 *   - Assert redemption SUCCEEDS iff B >= C:
 *       * SUCCESS: exactly one REDEMPTION ledger row of exactly -C is written
 *         for M (R18.5); the cost equals the STORED award's points_cost — the
 *         RPC takes no cost argument, so a -C row proves the derivation (R18.6);
 *         the member's new derived total == B - C.
 *       * FAILURE (B < C): the RPC raises INSUFFICIENT_POINTS, NO REDEMPTION row
 *         is written, and the derived total is unchanged at B (R18.7).
 *
 * Beyond the generated runs, one explicit scenario covers CONCURRENCY (R18.11)
 * that the generator cannot reliably produce: a member with balance exactly C
 * and TWO awards each costing C, redeemed concurrently on SEPARATE pg clients.
 * The member can afford only one. We assert AT MOST ONE succeeds and the
 * derived total never goes below 0 — the `FOR UPDATE` lock makes the two
 * redemptions take turns so the second sees the first's deduction.
 *
 * ----------------------------------------------------------------------------
 * RUN COUNT
 * ----------------------------------------------------------------------------
 * Each fast-check case does a full round trip to Postgres (reset + several
 * inserts + the RPC + verification queries). To keep wall-clock reasonable
 * while sampling a broad spread of balance/cost pairs we run 30 cases
 * (`NUM_RUNS`, within the 25–40 range the task calls for). The generator is
 * biased to hit all three behavioral partitions every execution — B > C
 * (success with surplus), B == C (success to exactly zero), and B < C (the
 * INSUFFICIENT_POINTS failure) — so the critical boundaries are always covered.
 * The modest magnitude range (0..5000) keeps generated balances realistic while
 * staying well inside the award `points_cost` 0..999999 domain.
 *
 * ----------------------------------------------------------------------------
 * GUARD / skip-without-DB
 * ----------------------------------------------------------------------------
 * Needs a reachable Postgres via TEST_DATABASE_URL (fallback DATABASE_URL).
 * When neither is set the suite SKIPS gracefully (describe.skip) so the default
 * `npm test` stays green in environments without a database. Setup/reset/seed
 * are shared through ./db-harness so this file only owns the Property-10
 * assertions.
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
} from './db-harness.js';

const NUM_RUNS = 30;

const HAS_DB = hasDatabase();

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn(
    '[redemption.property.test] SKIPPED: no TEST_DATABASE_URL / DATABASE_URL ' +
      'set. Set TEST_DATABASE_URL to a reachable Postgres to run the ' +
      'redemption property test (e.g. a disposable `docker run postgres`).',
  );
}

const suite = HAS_DB ? describe : describe.skip;

/**
 * Give a member a starting balance `balance` by inserting a single
 * MANUAL_ADJUSTMENT ledger row (none when balance = 0). The ledger is the
 * single source of truth, so this is how a member comes to "have" points.
 */
async function seedBalance(
  client: PgClient,
  seed: SeededFamily,
  balance: number,
): Promise<void> {
  if (balance <= 0) {
    return;
  }
  await client.query(
    `insert into points_transactions(family_id, member_id, task_id, points, transaction_type)
       values ($1, $2, null, $3, 'MANUAL_ADJUSTMENT')`,
    [seed.familyId, seed.memberId, balance],
  );
}

/** Insert an award worth `cost` for the seeded family; returns its id. */
async function seedAward(
  client: PgClient,
  seed: SeededFamily,
  cost: number,
): Promise<string> {
  const res = await client.query(
    `insert into awards(family_id, title, points_cost)
       values ($1, 'A reward', $2) returning id`,
    [seed.familyId, cost],
  );
  return res.rows[0].id as string;
}

/** The member's derived total = SUM of all their ledger rows (R10.1). */
async function memberTotal(
  client: PgClient,
  seed: SeededFamily,
): Promise<number> {
  const res = await client.query(
    `select coalesce(sum(points), 0)::int as total
       from points_transactions
      where family_id = $1 and member_id = $2`,
    [seed.familyId, seed.memberId],
  );
  return res.rows[0].total as number;
}

/** Count the REDEMPTION ledger rows for the seeded member. */
async function redemptionRows(
  client: PgClient,
  seed: SeededFamily,
): Promise<Array<{ points: number }>> {
  const res = await client.query(
    `select points from points_transactions
       where family_id = $1 and member_id = $2 and transaction_type = 'REDEMPTION'
       order by created_at asc, id asc`,
    [seed.familyId, seed.memberId],
  );
  return res.rows as Array<{ points: number }>;
}

/** True when a rejected RPC error is the named INSUFFICIENT_POINTS exception. */
function isInsufficient(err: unknown): boolean {
  return err instanceof Error && /INSUFFICIENT_POINTS/.test(err.message);
}

suite(
  'Feature: family-task-board-backend, Property 10: Redemption respects ' +
    'balance and records exactly the stored cost',
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

    it(
      'succeeds iff balance >= cost; on success writes exactly one -cost ' +
        'REDEMPTION and on failure writes nothing (R18.5/R18.6/R18.7)',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            // Starting balance B >= 0 and award cost C >= 0. Draw a base
            // magnitude, then pick a cost that lands in one of the three
            // partitions relative to B: strictly below (surplus success),
            // exactly equal (success to zero), or strictly above (failure).
            // This guarantees all three behavioral branches are hit on every
            // execution while still ranging over many (B, C) pairs.
            fc
              .record({
                balance: fc.integer({ min: 0, max: 5000 }),
                partition: fc.constantFrom<'below' | 'equal' | 'above'>(
                  'below',
                  'equal',
                  'above',
                ),
                delta: fc.integer({ min: 1, max: 5000 }),
              })
              .map(({ balance, partition, delta }) => {
                let cost: number;
                if (partition === 'equal') {
                  cost = balance;
                } else if (partition === 'below') {
                  // Strictly less than balance (clamped at 0). When balance is
                  // 0 this collapses to the equal case, which is fine.
                  cost = Math.max(0, balance - delta);
                } else {
                  // Strictly greater than balance → the overspend/failure path.
                  cost = balance + delta;
                }
                return { balance, cost };
              }),
            async ({ balance, cost }) => {
              // Fresh state per case so sums/counts are unambiguous.
              await reset(client);
              const seed = await seedFamily(client, { memberActive: true });

              await seedBalance(client, seed, balance);
              const awardId = await seedAward(client, seed, cost);

              // Sanity: the derived balance really is B before redeeming.
              expect(await memberTotal(client, seed)).toBe(balance);

              const shouldSucceed = balance >= cost;

              let rejected = false;
              let rejection: unknown;
              try {
                await client.query('select redeem_award($1, $2, $3)', [
                  awardId,
                  seed.memberId,
                  seed.familyId,
                ]);
              } catch (err) {
                rejected = true;
                rejection = err;
              }

              const redemptions = await redemptionRows(client, seed);
              const total = await memberTotal(client, seed);

              if (shouldSucceed) {
                // Redemption SUCCEEDS when B >= C.
                expect(rejected).toBe(false);
                // Exactly one REDEMPTION row of exactly -C (R18.5). The cost is
                // derived from the STORED award — the RPC takes no cost arg, so
                // a -C row proves the derivation (R18.6). `+ 0` normalizes the
                // signed-zero edge: a C = 0 (free) award stores a REDEMPTION of
                // 0, and `toBe` uses Object.is which would otherwise treat the
                // expected `-0` as distinct from the stored `0`.
                expect(redemptions).toHaveLength(1);
                expect(redemptions[0]!.points).toBe(-cost + 0);
                // The member's new derived total == B - C.
                expect(total).toBe(balance - cost);
                // Never below zero on the success path.
                expect(total).toBeGreaterThanOrEqual(0);
              } else {
                // Redemption FAILS when B < C: INSUFFICIENT_POINTS raised,
                // NO ledger row written, derived total unchanged (R18.7).
                expect(rejected).toBe(true);
                expect(isInsufficient(rejection)).toBe(true);
                expect(redemptions).toHaveLength(0);
                expect(total).toBe(balance);
              }
            },
          ),
          { numRuns: NUM_RUNS },
        );
      },
      120_000,
    );

    it(
      'serializes concurrent redemptions: a member who can afford only one of ' +
        'two equal-cost awards redeems at most once and never goes below 0 (R18.11)',
      async () => {
        // Balance EXACTLY C, two awards each costing C. The member can afford
        // exactly one redemption.
        const C = 100;
        await reset(client);
        const seed = await seedFamily(client, { memberActive: true });
        await seedBalance(client, seed, C);
        const awardA = await seedAward(client, seed, C);
        const awardB = await seedAward(client, seed, C);

        expect(await memberTotal(client, seed)).toBe(C);

        // Two SEPARATE connections so the redemptions genuinely race on the
        // member row's FOR UPDATE lock in the RPC; one wins, the other sees the
        // first's deduction and is rejected for insufficient balance.
        const a = await connect();
        const b = await connect();
        try {
          const fire = (c: PgClient, awardId: string) =>
            c
              .query('select redeem_award($1, $2, $3)', [
                awardId,
                seed.memberId,
                seed.familyId,
              ])
              .then(
                () => ({ ok: true as const }),
                (err: unknown) => ({ ok: false as const, err }),
              );

          const results = await Promise.all([
            fire(a, awardA),
            fire(b, awardB),
          ]);

          const succeeded = results.filter((r) => r.ok);
          const failed = results.filter((r) => !r.ok);

          // At most one redemption succeeds (exactly one here: the member can
          // afford one). The loser is rejected for insufficient balance.
          expect(succeeded.length).toBeLessThanOrEqual(1);
          expect(succeeded).toHaveLength(1);
          expect(failed).toHaveLength(1);
          const failure = failed[0] as { ok: false; err: unknown };
          expect(isInsufficient(failure.err)).toBe(true);

          // Exactly one REDEMPTION row of -C, and the derived total settled at
          // 0 — never driven below 0 (R18.11).
          const redemptions = await redemptionRows(client, seed);
          expect(redemptions).toHaveLength(1);
          expect(redemptions[0]!.points).toBe(-C);
          const total = await memberTotal(client, seed);
          expect(total).toBe(0);
          expect(total).toBeGreaterThanOrEqual(0);
        } finally {
          await a.end();
          await b.end();
        }
      },
      60_000,
    );
  },
);
