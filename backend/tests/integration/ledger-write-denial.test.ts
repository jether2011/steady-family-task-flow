/**
 * Ledger write-denial integration test — the DATABASE half of task 13.2 (R23.6).
 *
 * This is the point-manipulation guard at the RLS layer: a client holding a
 * user JWT (the `authenticated` role) must be unable to fabricate points or
 * completions. The schema (migration `003_rls.sql`) achieves this by enabling
 * RLS on `points_transactions` and `task_completions` and giving the
 * `authenticated` role ONLY a family-scoped SELECT policy — deliberately NO
 * insert/update/delete policy. With RLS enabled and no matching write policy,
 * PostgreSQL denies the write; the ledger is written solely by the service role
 * through the SECURITY DEFINER RPCs (`complete_task` / `reopen_task` /
 * `redeem_award`).
 *
 * ----------------------------------------------------------------------------
 * WHY A STRUCTURAL pg_policies ASSERTION (not a live SET ROLE insert)
 * ----------------------------------------------------------------------------
 * The shared harness (`db-harness.ts`) connects as the database OWNER, and a
 * table owner BYPASSES RLS by default (`BYPASSRLS`-equivalent). So a direct
 * `INSERT` from the harness connection would succeed regardless of policy and
 * prove nothing. Faithfully simulating the `authenticated` role in a bare
 * throwaway Postgres is unreliable (it needs the Supabase `auth.uid()` /
 * JWT plumbing and a non-owner, non-superuser login role with the right grants).
 *
 * Per the task guidance we therefore prove R23.6 STRUCTURALLY by querying
 * `pg_policies`: assert each ledger table has a SELECT policy for
 * `authenticated` and NO INSERT/UPDATE/DELETE policy for any role. That absence,
 * combined with RLS being enabled, is exactly what denies user-role writes. A
 * best-effort live `SET ROLE authenticated` insert is attempted as a secondary
 * confirmation and only asserted when the role genuinely does not bypass RLS.
 *
 * ----------------------------------------------------------------------------
 * GUARD
 * ----------------------------------------------------------------------------
 * Needs a reachable Postgres via TEST_DATABASE_URL (fallback DATABASE_URL).
 * When neither is set the suite SKIPS so the default `npm test` stays green in
 * environments without a database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applySchema, connect, hasDatabase, type PgClient } from './db-harness.js';

const HAS_DB = hasDatabase();

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn(
    '[ledger-write-denial.test] SKIPPED: no TEST_DATABASE_URL / DATABASE_URL ' +
      'set. Set TEST_DATABASE_URL to a reachable Postgres to run the ledger ' +
      'write-denial (RLS structural) integration test.',
  );
}

const suite = HAS_DB ? describe : describe.skip;

/** The two append-only ledger tables the user role must never write (R23.6). */
const LEDGER_TABLES = ['points_transactions', 'task_completions'] as const;

/** The write command letters pg_policies reports for insert/update/delete. */
const WRITE_COMMANDS = new Set(['INSERT', 'UPDATE', 'DELETE']);

interface PolicyRow {
  tablename: string;
  policyname: string;
  // pg_policies.cmd is one of: SELECT, INSERT, UPDATE, DELETE, ALL ('*').
  cmd: string;
  // pg_policies.roles is a Postgres text[] of role names the policy targets.
  roles: string[];
}

suite('ledger write-denial — RLS point-manipulation guard (R23.6)', () => {
  let client: PgClient;

  async function policiesFor(table: string): Promise<PolicyRow[]> {
    const res = await client.query(
      `select tablename, policyname, cmd, roles
         from pg_policies
        where schemaname = 'public' and tablename = $1`,
      [table],
    );
    return res.rows as PolicyRow[];
  }

  beforeAll(async () => {
    client = await connect();
    await applySchema(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.end();
    }
  });

  it('enables RLS on both ledger tables (R23.1/R23.6)', async () => {
    const res = await client.query(
      `select relname, relrowsecurity
         from pg_class
        where relnamespace = 'public'::regnamespace
          and relname = any($1::text[])`,
      [LEDGER_TABLES as unknown as string[]],
    );
    const byName = new Map<string, boolean>(
      res.rows.map((r: { relname: string; relrowsecurity: boolean }) => [
        r.relname,
        r.relrowsecurity,
      ]),
    );
    for (const table of LEDGER_TABLES) {
      expect(byName.get(table), `RLS must be enabled on ${table}`).toBe(true);
    }
  });

  it.each(LEDGER_TABLES)(
    '%s has a SELECT policy for authenticated but NO insert/update/delete policy (R23.6)',
    async (table) => {
      const policies = await policiesFor(table);

      // There must be at least one SELECT policy, scoped to `authenticated`,
      // so the frontend can still render points/history with the user JWT.
      const selectPolicies = policies.filter(
        (p) => p.cmd === 'SELECT' || p.cmd === 'ALL',
      );
      expect(
        selectPolicies.length,
        `${table} must expose a SELECT policy for reads`,
      ).toBeGreaterThan(0);
      expect(
        selectPolicies.some((p) => p.roles.includes('authenticated')),
        `${table} SELECT policy must target the authenticated role`,
      ).toBe(true);

      // The core guard: NO policy may permit a write for any role. A policy with
      // cmd INSERT/UPDATE/DELETE — or a permissive ALL — would open a user-role
      // write path and defeat R23.6.
      const writePolicies = policies.filter(
        (p) => WRITE_COMMANDS.has(p.cmd) || p.cmd === 'ALL',
      );
      expect(
        writePolicies,
        `${table} must have NO insert/update/delete (or ALL) policy; found: ` +
          writePolicies.map((p) => `${p.policyname}(${p.cmd})`).join(', '),
      ).toHaveLength(0);
    },
  );

  it('confirms writes are denied under SET ROLE authenticated when the role does not bypass RLS (R23.6)', async () => {
    // Secondary, best-effort live check. The harness connects as the owner, who
    // bypasses RLS, so we switch to the `authenticated` role (created by the
    // harness shim) for the duration of a sub-transaction. If that role happens
    // to bypass RLS in this environment (e.g. it inherited superuser/BYPASSRLS),
    // we skip the live assertion and rely on the structural proof above.
    const bypass = await client.query(
      `select rolbypassrls, rolsuper
         from pg_roles where rolname = 'authenticated'`,
    );
    const row = bypass.rows[0] as
      | { rolbypassrls: boolean; rolsuper: boolean }
      | undefined;
    const roleBypassesRls = row ? row.rolbypassrls || row.rolsuper : true;

    if (roleBypassesRls) {
      // eslint-disable-next-line no-console
      console.warn(
        '[ledger-write-denial.test] authenticated role bypasses RLS in this ' +
          'environment; relying on the structural pg_policies proof instead.',
      );
      return;
    }

    await client.query('begin');
    try {
      await client.query('set local role authenticated');
      let denied = false;
      try {
        await client.query(
          `insert into points_transactions
             (family_id, member_id, task_id, points, transaction_type)
           values (gen_random_uuid(), gen_random_uuid(), null, 999, 'TASK_COMPLETION')`,
        );
      } catch {
        // RLS (or the absent write policy) rejected the insert — the guard holds.
        denied = true;
      }
      expect(
        denied,
        'authenticated role must NOT be able to insert into points_transactions',
      ).toBe(true);
    } finally {
      // Roll back the role switch and any partial statement state.
      await client.query('rollback');
    }
  });
});
