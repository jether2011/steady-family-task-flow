/**
 * Shared integration-test harness for the real-Postgres suites.
 *
 * The atomic ledger RPCs (`complete_task` / `reopen_task` / `redeem_award`) and
 * the `UNIQUE(task_id)` + `FOR UPDATE` concurrency guarantees can only be
 * exercised against a genuine PostgreSQL instance — they are plpgsql functions
 * that run in one implicit DB transaction and rely on row locks and a unique
 * index. This module centralises the plumbing those suites share:
 *
 *   - `getConnectionString()` / `hasDatabase()` — read TEST_DATABASE_URL
 *     (fallback DATABASE_URL) and report whether a DB is reachable, so each
 *     suite can `describe.skip` and keep the default `npm test` green when no
 *     database is configured.
 *   - `connect()` — open a `pg` Client against that URL.
 *   - `applySchema(client)` — drop/recreate `public`, install the minimal
 *     `auth.*` + roles + pgcrypto shim (Supabase provides these in production;
 *     a bare Postgres does not), then apply migrations 001 → 006 in order.
 *   - `reset(client)` — truncate every application table between property runs
 *     so each run starts from an empty, deterministic state (identities are
 *     left intact).
 *   - `seedFamily(client, …)` — insert the minimal graph a completion test
 *     needs: a responsible user (+ its auth.users row), a family, and an active
 *     member. Returns the generated ids.
 *   - `seedTask(client, …)` — insert one non-DONE task with a chosen point
 *     value, returning its id.
 *
 * ----------------------------------------------------------------------------
 * auth.* shim (see migrations.test.ts for the fuller rationale)
 * ----------------------------------------------------------------------------
 * On real Supabase the `auth` schema, `auth.users`, `auth.uid()`,
 * `gen_random_uuid()`, and the `authenticated` / `service_role` roles already
 * exist. On a throwaway Postgres they do not, so `applySchema` creates a
 * minimal stand-in before the migrations run. It exists only so the DDL applies
 * cleanly; RLS behaviour itself is covered by other suites.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SUPABASE_DIR = join(here, '..', '..', 'src', 'supabase');
const MIGRATIONS_DIR = join(SUPABASE_DIR, 'migrations');

/** Migrations applied in strict order (006 included per task 2.7's note). */
export const MIGRATION_FILES = [
  '001_initial_schema.sql',
  '002_indexes.sql',
  '003_rls.sql',
  '004_functions.sql',
  '005_realtime.sql',
  '006_update_family.sql',
] as const;

/** The eight application tables, in truncate-safe order (CASCADE handles FKs). */
export const APP_TABLES = [
  'task_completions',
  'points_transactions',
  'awards',
  'tasks',
  'task_templates',
  'family_members',
  'families',
  'responsible_users',
] as const;

/**
 * Minimal auth.* + roles + pgcrypto shim. Mirrors migrations.test.ts so both
 * suites validate the same artifacts against the same stand-in platform objects.
 */
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

/** Resolve the Postgres connection string from the environment. */
export function getConnectionString(): string {
  return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
}

/** Whether a Postgres instance is configured/reachable for the integration suites. */
export function hasDatabase(): boolean {
  return getConnectionString().length > 0;
}

// `pg` has no bundled types we import here (and is a devDependency), so the
// client is loosely typed; the suites only use `.query` / `.connect` / `.end`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PgClient = any;

/** Open and connect a fresh `pg` Client against the configured database. */
export async function connect(): Promise<PgClient> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: getConnectionString() });
  await client.connect();
  return client;
}

async function readMigration(file: string): Promise<string> {
  return readFile(join(MIGRATIONS_DIR, file), 'utf8');
}

/**
 * Rebuild the schema from scratch: drop/recreate `public`, drop the auth shim,
 * reinstall the shim, then apply every migration in order. Safe to call once in
 * a suite's `beforeAll`.
 */
export async function applySchema(client: PgClient): Promise<void> {
  await client.query('drop schema if exists public cascade');
  await client.query('create schema public');
  await client.query('drop schema if exists auth cascade');
  await client.query(AUTH_SHIM_SQL);
  for (const file of MIGRATION_FILES) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(await readMigration(file));
  }
}

/** Truncate every application table so each property run starts clean. */
export async function reset(client: PgClient): Promise<void> {
  await client.query(
    `truncate table ${APP_TABLES.join(', ')} restart identity cascade`,
  );
}

export interface SeededFamily {
  authUserId: string;
  responsibleUserId: string;
  familyId: string;
  memberId: string;
}

/**
 * Insert the minimal graph a completion test needs: an auth.users row, a
 * responsible user, a family, and one active member. Returns the generated ids.
 */
export async function seedFamily(
  client: PgClient,
  opts: { memberActive?: boolean } = {},
): Promise<SeededFamily> {
  const memberActive = opts.memberActive ?? true;

  const auth = await client.query(
    `insert into auth.users (email) values ('owner@example.test') returning id`,
  );
  const authUserId = auth.rows[0].id as string;

  const resp = await client.query(
    `insert into responsible_users (auth_user_id, name, email, relationship)
       values ($1, 'Owner', 'owner@example.test', 'MOTHER')
       returning id`,
    [authUserId],
  );
  const responsibleUserId = resp.rows[0].id as string;

  const fam = await client.query(
    `insert into families (responsible_user_id, name)
       values ($1, 'Test Family') returning id`,
    [responsibleUserId],
  );
  const familyId = fam.rows[0].id as string;

  const mem = await client.query(
    `insert into family_members (family_id, name, member_type, active)
       values ($1, 'Kid', 'CHILD', $2) returning id`,
    [familyId, memberActive],
  );
  const memberId = mem.rows[0].id as string;

  return { authUserId, responsibleUserId, familyId, memberId };
}

/**
 * Insert one non-DONE task worth `points` for the seeded family, created by the
 * seeded responsible user. Returns the task id.
 */
export async function seedTask(
  client: PgClient,
  seed: SeededFamily,
  opts: { points?: number; status?: string } = {},
): Promise<string> {
  const points = opts.points ?? 0;
  const status = opts.status ?? 'TODO';
  const res = await client.query(
    `insert into tasks (family_id, title, created_by_user_id, status, points, assigned_member_id)
       values ($1, 'A chore', $2, $3, $4, $5)
       returning id`,
    [seed.familyId, seed.responsibleUserId, status, points, seed.memberId],
  );
  return res.rows[0].id as string;
}
