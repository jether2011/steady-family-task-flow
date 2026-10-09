/**
 * Migration + seed integration test (task 2.7).
 *
 * This suite exercises the raw SQL artifacts in src/supabase against a REAL
 * PostgreSQL instance:
 *
 *   1. Apply migrations 001 -> 006 in order to an empty database and assert the
 *      full application schema exists: the 8 app tables, the key UNIQUE
 *      constraints (task_completions.task_id, families.responsible_user_id),
 *      the transaction_type CHECK covering REDEMPTION, and the four atomic RPC
 *      functions (complete_task, reopen_task, redeem_award, update_family).
 *      This is Requirement 28.3 — the applied schema supports every backend
 *      route with no manual edits.
 *
 *   2. Run seed.sql, count the demo rows, run seed.sql a SECOND time, re-count,
 *      and assert the counts are identical — Requirement 28.5 (running the seed
 *      twice creates no duplicate records and does not error).
 *
 * ----------------------------------------------------------------------------
 * auth.* SHIM (important)
 * ----------------------------------------------------------------------------
 * The schema targets Supabase, where the `auth` schema, the `auth.users` table,
 * and `auth.uid()` already exist and `gen_random_uuid()` is available. On a
 * bare test Postgres none of that is present, so BEFORE applying 001 this test
 * creates a MINIMAL shim:
 *   - `create extension pgcrypto`  -> provides gen_random_uuid()
 *   - a minimal `auth` schema + `auth.users` table (only the columns the
 *     migrations/seed reference) so the responsible_users FK and the demo
 *     auth.users insert in seed.sql resolve.
 *   - an `auth.uid()` stub returning NULL, so current_family_id() and the RLS
 *     policies in 003 compile. (RLS behavior itself is covered elsewhere; here
 *     we only need the DDL to apply cleanly.)
 *   - the `authenticated` and `service_role` roles that the 003 RLS policies
 *     grant to (`... to authenticated`). Supabase ships these roles; a bare
 *     Postgres does not, so the policy DDL would fail without them.
 * In real Supabase these are provided by the platform — the shim exists solely
 * so the migrations can be validated on a throwaway Postgres.
 *
 * ----------------------------------------------------------------------------
 * GUARD
 * ----------------------------------------------------------------------------
 * The suite needs a reachable Postgres via TEST_DATABASE_URL (fallback
 * DATABASE_URL). When neither is set the suite SKIPS gracefully so the default
 * `npm test` stays green in environments without a database.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CONNECTION_STRING =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

const HAS_DB = CONNECTION_STRING.length > 0;

const here = dirname(fileURLToPath(import.meta.url));
const SUPABASE_DIR = join(here, '..', '..', 'src', 'supabase');
const MIGRATIONS_DIR = join(SUPABASE_DIR, 'migrations');

// Migrations applied in strict order. 006 is included per the task note.
const MIGRATION_FILES = [
  '001_initial_schema.sql',
  '002_indexes.sql',
  '003_rls.sql',
  '004_functions.sql',
  '005_realtime.sql',
  '006_update_family.sql',
] as const;

// The eight application tables (public schema).
const APP_TABLES = [
  'responsible_users',
  'families',
  'family_members',
  'task_templates',
  'tasks',
  'task_completions',
  'points_transactions',
  'awards',
] as const;

// The four atomic RPC functions the backend routes invoke.
const RPC_FUNCTIONS = [
  'complete_task',
  'reopen_task',
  'redeem_award',
  'update_family',
] as const;

// Minimal auth.* shim: on real Supabase these objects are provided by the
// platform; a bare Postgres needs them before 001/seed can apply.
const AUTH_SHIM_SQL = `
  create extension if not exists pgcrypto;

  -- Supabase-provided roles that the 003 RLS policies grant to. A bare Postgres
  -- lacks them, so create them here (NOLOGIN, like Supabase's own).
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
    '[migrations.test] SKIPPED: no TEST_DATABASE_URL / DATABASE_URL set. ' +
      'Set TEST_DATABASE_URL to a reachable Postgres to run the migration + ' +
      'seed integration test (e.g. a disposable `docker run postgres`).',
  );
}

// describe.skip when there is no database, so the rest of `npm test` stays green.
const suite = HAS_DB ? describe : describe.skip;

suite('migrations + seed integration (R28.3, R28.5)', () => {
  // `pg` is only required inside the guarded suite so that environments without
  // the dependency (and without a DB) are unaffected.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;

  async function readSql(file: string): Promise<string> {
    return readFile(join(MIGRATIONS_DIR, file), 'utf8');
  }

  async function countRows(table: string): Promise<number> {
    const res = await client.query(`select count(*)::int as n from ${table}`);
    return res.rows[0].n as number;
  }

  beforeAll(async () => {
    const { Client } = await import('pg');
    client = new Client({ connectionString: CONNECTION_STRING });
    await client.connect();

    // Start from a clean slate so repeated runs are deterministic. Drop both
    // the application schema and the auth shim.
    await client.query('drop schema if exists public cascade');
    await client.query('create schema public');
    await client.query('drop schema if exists auth cascade');

    // 1) auth.* + pgcrypto shim BEFORE any migration.
    await client.query(AUTH_SHIM_SQL);

    // 2) apply every migration in order.
    for (const file of MIGRATION_FILES) {
      const sql = await readSql(file);
      await client.query(sql);
    }
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.end();
    }
  });

  it('creates all 8 application tables (R28.3)', async () => {
    const res = await client.query(
      `select table_name from information_schema.tables
         where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const found = new Set<string>(
      res.rows.map((r: { table_name: string }) => r.table_name),
    );
    for (const table of APP_TABLES) {
      expect(found.has(table), `expected table "${table}" to exist`).toBe(true);
    }
  });

  it('enforces UNIQUE(task_id) on task_completions (R28.2)', async () => {
    const res = await client.query(
      `select 1
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
          and kcu.table_schema = tc.table_schema
        where tc.table_schema = 'public'
          and tc.table_name = 'task_completions'
          and tc.constraint_type = 'UNIQUE'
          and kcu.column_name = 'task_id'`,
    );
    expect(res.rowCount).toBeGreaterThan(0);
  });

  it('enforces UNIQUE(responsible_user_id) on families (R1.6)', async () => {
    const res = await client.query(
      `select 1
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
          and kcu.table_schema = tc.table_schema
        where tc.table_schema = 'public'
          and tc.table_name = 'families'
          and tc.constraint_type = 'UNIQUE'
          and kcu.column_name = 'responsible_user_id'`,
    );
    expect(res.rowCount).toBeGreaterThan(0);
  });

  it('transaction_type CHECK includes REDEMPTION (R18.12)', async () => {
    const res = await client.query(
      `select cc.check_clause
         from information_schema.check_constraints cc
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_name = cc.constraint_name
          and ccu.constraint_schema = cc.constraint_schema
        where ccu.table_schema = 'public'
          and ccu.table_name = 'points_transactions'
          and ccu.column_name = 'transaction_type'`,
    );
    const clauses = res.rows
      .map((r: { check_clause: string }) => r.check_clause)
      .join(' ');
    expect(clauses).toContain('REDEMPTION');
  });

  it('creates the four atomic RPC functions (R28.3)', async () => {
    const res = await client.query(
      `select p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'`,
    );
    const found = new Set<string>(
      res.rows.map((r: { proname: string }) => r.proname),
    );
    for (const fn of RPC_FUNCTIONS) {
      expect(found.has(fn), `expected function "${fn}" to exist`).toBe(true);
    }
  });

  it('runs seed.sql twice without creating duplicate rows (R28.5)', async () => {
    const seedSql = await readFile(join(SUPABASE_DIR, 'seed.sql'), 'utf8');
    const SEEDED_TABLES = [
      'families',
      'family_members',
      'task_templates',
      'tasks',
    ] as const;

    // First run — populates the demo dataset.
    await client.query(seedSql);
    const afterFirst: Record<string, number> = {};
    for (const table of SEEDED_TABLES) {
      afterFirst[table] = await countRows(table);
    }

    // Every seeded table must actually have the expected demo rows after run 1,
    // otherwise an "identical" count of 0 would falsely pass.
    expect(afterFirst.families).toBe(1);
    expect(afterFirst.family_members).toBe(4);
    expect(afterFirst.task_templates).toBe(6);
    expect(afterFirst.tasks).toBe(6);

    // Second run — must be a no-op (on conflict do nothing), no error.
    await client.query(seedSql);
    for (const table of SEEDED_TABLES) {
      const afterSecond = await countRows(table);
      expect(
        afterSecond,
        `row count for "${table}" changed after a second seed run`,
      ).toBe(afterFirst[table]);
    }
  });
});
