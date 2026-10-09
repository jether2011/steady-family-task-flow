-- seed.sql
-- Family Task Board — idempotent "Rodrigues Family" demo seed data.
--
-- Requirements: R28.4 (Rodrigues Family demo: Family, Family_Members,
-- Task_Templates, Tasks) and R28.5 (running the seed twice creates no
-- duplicate records and does not error).
--
-- IDEMPOTENCY STRATEGY
-- --------------------
-- Every demo row uses a STABLE, FIXED UUID as its primary key, and every
-- INSERT ends with `on conflict (id) do nothing`. The fixed UUID *is* the
-- stable natural key for the demo dataset, so a second (or hundredth) run
-- re-attempts the same primary keys, hits the conflict target, and inserts
-- nothing — no duplicates, no errors. Fixed PKs also keep every foreign-key
-- reference below (family -> members -> tasks) deterministic across runs.
--
-- AUTH PREREQUISITE (responsible_users.auth_user_id -> auth.users(id))
-- --------------------------------------------------------------------
-- `responsible_users.auth_user_id` is a NOT NULL foreign key into Supabase's
-- `auth.users` table. A responsible user cannot exist without a backing auth
-- user, so this seed first inserts a demo row into `auth.users` with a fixed
-- UUID, guarded by `on conflict (id) do nothing`.
--
-- This insert works against a fresh LOCAL/DEV Supabase database, where the
-- role running the seed (e.g. the `postgres` superuser used by the Supabase
-- CLI / local stack) is allowed to write to the `auth` schema. In a hosted
-- Supabase project you normally create the auth user through Google OAuth
-- (first login) or the Admin API instead; if the privileged seed cannot write
-- to `auth.users` there, the demo auth insert will simply be skipped by the
-- same conflict/row-exists semantics once a real auth user with this UUID
-- already exists. The real app path remains R1.4 (family auto-created on first
-- `GET /api/v1/me`); this seed is a dev/demo convenience only.
--
-- Stable demo UUIDs (documented here so they can be reused by tests/tools):
--   auth user / responsible user ... see constants below
--   family ...................... 1b000000-0000-4000-8000-000000000001
--   members (Ana/Lucas/Marina/Pedro) and tasks ... see sections below

begin;

-- 1) Demo auth user (prerequisite for responsible_users FK). ------------------
--    Dev/local only; harmlessly skipped if the row already exists.
insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  '0a000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'jether.rodrigues@example.com',
  '{"provider":"google","providers":["google"]}'::jsonb,
  '{"full_name":"Jether Rodrigues"}'::jsonb,
  now(),
  now()
)
on conflict (id) do nothing;

-- 2) Responsible user (Jether, FATHER). ---------------------------------------
insert into responsible_users (id, auth_user_id, name, email, relationship)
values (
  '09000000-0000-4000-8000-000000000001',
  '0a000000-0000-4000-8000-000000000001',
  'Jether Rodrigues',
  'jether.rodrigues@example.com',
  'FATHER'
)
on conflict (id) do nothing;

-- 3) Family (Rodrigues Family), owned by Jether. ------------------------------
insert into families (id, responsible_user_id, name)
values (
  '1b000000-0000-4000-8000-000000000001',
  '09000000-0000-4000-8000-000000000001',
  'Rodrigues Family'
)
on conflict (id) do nothing;

-- 4) Family members: Ana (PARENT), Lucas (CHILD), Marina (CHILD), Pedro (DEPENDENT).
insert into family_members (id, family_id, name, member_type, active)
values
  ('2c000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-000000000001', 'Ana',    'PARENT',    true),
  ('2c000000-0000-4000-8000-000000000002', '1b000000-0000-4000-8000-000000000001', 'Lucas',  'CHILD',     true),
  ('2c000000-0000-4000-8000-000000000003', '1b000000-0000-4000-8000-000000000001', 'Marina', 'CHILD',     true),
  ('2c000000-0000-4000-8000-000000000004', '1b000000-0000-4000-8000-000000000001', 'Pedro',  'DEPENDENT', true)
on conflict (id) do nothing;

-- 5) Task templates (recurring chores), one per demo task below. --------------
--    DAILY/WEEKDAYS/WEEKLY mix exercises recurrence generation (R12/R13).
insert into task_templates (id, family_id, title, assigned_member_id, points, priority, recurrence_type, recurrence_config, active)
values
  ('3d000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-000000000001', 'Make bed',      '2c000000-0000-4000-8000-000000000002',  5, 'LOW',    'DAILY',    '{}'::jsonb,            true),
  ('3d000000-0000-4000-8000-000000000002', '1b000000-0000-4000-8000-000000000001', 'Feed dog',      '2c000000-0000-4000-8000-000000000002', 10, 'MEDIUM', 'DAILY',    '{}'::jsonb,            true),
  ('3d000000-0000-4000-8000-000000000003', '1b000000-0000-4000-8000-000000000001', 'Homework',      '2c000000-0000-4000-8000-000000000003', 15, 'HIGH',   'WEEKDAYS', '{}'::jsonb,            true),
  ('3d000000-0000-4000-8000-000000000004', '1b000000-0000-4000-8000-000000000001', 'Clean bedroom', '2c000000-0000-4000-8000-000000000003', 20, 'MEDIUM', 'WEEKLY',   '{}'::jsonb,            true),
  ('3d000000-0000-4000-8000-000000000005', '1b000000-0000-4000-8000-000000000001', 'Water plants',  '2c000000-0000-4000-8000-000000000004', 10, 'LOW',    'CUSTOM',   '{"days":[1,4]}'::jsonb, true),
  ('3d000000-0000-4000-8000-000000000006', '1b000000-0000-4000-8000-000000000001', 'Wash dishes',   '2c000000-0000-4000-8000-000000000001', 15, 'MEDIUM', 'DAILY',    '{}'::jsonb,            true)
on conflict (id) do nothing;

-- 6) Tasks (one per demo chore). ----------------------------------------------
--    due_date / week_start are pinned to a fixed Monday-anchored demo week so
--    the seeded rows are deterministic across runs. created_by_user_id points
--    at the seeded responsible user; assigned_member_id at the seeded members.
--      Make bed      -> Lucas  (5)
--      Feed dog      -> Lucas  (10)
--      Homework      -> Marina (15)
--      Clean bedroom -> Marina (20)
--      Water plants  -> Pedro  (10)
--      Wash dishes   -> Ana    (15)
insert into tasks (
  id, family_id, template_id, title, assigned_member_id, created_by_user_id,
  status, priority, points, due_date, week_start
)
values
  ('4e000000-0000-4000-8000-000000000001', '1b000000-0000-4000-8000-000000000001', '3d000000-0000-4000-8000-000000000001', 'Make bed',      '2c000000-0000-4000-8000-000000000002', '09000000-0000-4000-8000-000000000001', 'TODO', 'LOW',     5, date '2025-01-06', date '2025-01-06'),
  ('4e000000-0000-4000-8000-000000000002', '1b000000-0000-4000-8000-000000000001', '3d000000-0000-4000-8000-000000000002', 'Feed dog',      '2c000000-0000-4000-8000-000000000002', '09000000-0000-4000-8000-000000000001', 'TODO', 'MEDIUM', 10, date '2025-01-06', date '2025-01-06'),
  ('4e000000-0000-4000-8000-000000000003', '1b000000-0000-4000-8000-000000000001', '3d000000-0000-4000-8000-000000000003', 'Homework',      '2c000000-0000-4000-8000-000000000003', '09000000-0000-4000-8000-000000000001', 'TODO', 'HIGH',   15, date '2025-01-06', date '2025-01-06'),
  ('4e000000-0000-4000-8000-000000000004', '1b000000-0000-4000-8000-000000000001', '3d000000-0000-4000-8000-000000000004', 'Clean bedroom', '2c000000-0000-4000-8000-000000000003', '09000000-0000-4000-8000-000000000001', 'TODO', 'MEDIUM', 20, date '2025-01-06', date '2025-01-06'),
  ('4e000000-0000-4000-8000-000000000005', '1b000000-0000-4000-8000-000000000001', '3d000000-0000-4000-8000-000000000005', 'Water plants',  '2c000000-0000-4000-8000-000000000004', '09000000-0000-4000-8000-000000000001', 'TODO', 'LOW',    10, date '2025-01-06', date '2025-01-06'),
  ('4e000000-0000-4000-8000-000000000006', '1b000000-0000-4000-8000-000000000001', '3d000000-0000-4000-8000-000000000006', 'Wash dishes',   '2c000000-0000-4000-8000-000000000001', '09000000-0000-4000-8000-000000000001', 'TODO', 'MEDIUM', 15, date '2025-01-06', date '2025-01-06')
on conflict (id) do nothing;

commit;
