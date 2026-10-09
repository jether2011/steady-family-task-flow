-- 005_realtime.sql
-- Family Task Board — Supabase Realtime enablement.
--
-- The frontend subscribes to live Postgres changes on `tasks`,
-- `task_completions`, and `points_transactions`, filtered to the family
-- (`family_id=eq.<familyId>`), and invalidates its TanStack Query caches on
-- every event (R21.1–R21.3). Supabase Realtime streams a table's changes only
-- when that table is a member of the `supabase_realtime` logical-replication
-- publication, so this migration adds the three ledger/board tables to it.
--
-- Two things must be true for the stream to be useful here:
--
--   1. Membership in the `supabase_realtime` publication — otherwise no change
--      events are emitted for the table at all.
--
--   2. REPLICA IDENTITY FULL on each table — the default REPLICA IDENTITY
--      (the primary key) puts only the key in the WAL for UPDATE/DELETE, so the
--      old row's other columns (notably `family_id`) are absent from the change
--      payload. Realtime's RLS-based row filtering and the frontend's
--      `family_id=eq.<id>` filter both need the full old record to decide
--      whether an UPDATE/DELETE belongs to the subscribing family. FULL puts
--      every column of the old row in the WAL so those filters work on deletes
--      and updates, not just inserts.
--
-- Idempotency / robustness: Supabase provisions the `supabase_realtime`
-- publication for new projects, but it may be absent on a bare Postgres, and a
-- table may already be a member if this (or an equivalent) migration ran
-- before. Everything below is therefore guarded so the migration can be
-- applied repeatedly and against either state without error:
--   - the publication is created only when missing (checked via pg_publication);
--   - each table is added only when not already a member (checked via
--     pg_publication_tables), so no duplicate-membership error is raised;
--   - REPLICA IDENTITY FULL is idempotent by nature (re-setting is a no-op).
--
-- Requirements: R28.1 (migrations), supporting R21.1–R21.3 (frontend realtime).

-- ---------------------------------------------------------------------------
-- REPLICA IDENTITY FULL for the realtime tables
-- ---------------------------------------------------------------------------
-- Required so UPDATE/DELETE change events carry the full old row, letting
-- Realtime apply RLS and the frontend apply its `family_id` filter on those
-- events (not only on INSERTs). Re-running is a harmless no-op.
alter table tasks               replica identity full;
alter table task_completions    replica identity full;
alter table points_transactions replica identity full;

-- ---------------------------------------------------------------------------
-- supabase_realtime publication membership (idempotent)
-- ---------------------------------------------------------------------------
do $$
begin
  -- Create the publication only if Supabase (or a prior run) hasn't already.
  -- No `for all tables` clause, so nothing is streamed implicitly; membership
  -- is opt-in and added explicitly per table below, matching Supabase's own
  -- managed publication. It publishes insert/update/delete so the frontend
  -- sees every relevant change.
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    create publication supabase_realtime with (publish = 'insert, update, delete');
  end if;

  -- Add each table only when it isn't already a member, so a pre-existing
  -- Supabase publication that already includes the table does not raise a
  -- duplicate error.
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table tasks;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'task_completions'
  ) then
    alter publication supabase_realtime add table task_completions;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'points_transactions'
  ) then
    alter publication supabase_realtime add table points_transactions;
  end if;
end
$$;
