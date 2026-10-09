-- 001_initial_schema.sql
-- Family Task Board — initial schema (Supabase Postgres).
--
-- Enums are implemented as TEXT ... CHECK (...) constraints to match the Base44
-- field names and keep migrations portable. All PKs use gen_random_uuid()
-- (built into Supabase). Timestamps are timestamptz with now() defaults; the
-- updated_at refresh TRIGGER is added in a later migration (not here).
--
-- Tables are declared in FK-dependency order so references resolve:
--   responsible_users -> families -> family_members / task_templates
--   -> tasks -> task_completions / points_transactions, awards
--
-- Requirements: R28.2 (UNIQUE task_id on completions), R28.3 (schema/constraints),
-- R9.1 (one completion per task), R18.12 (REDEMPTION in transaction_type CHECK),
-- R1.6 (one family per responsible user -> UNIQUE responsible_user_id).

-- responsible_users: one row per authenticated adult
create table responsible_users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  name text,
  email text,
  avatar_url text,
  relationship text check (relationship in ('FATHER','MOTHER','GUARDIAN','OTHER')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table families (
  id uuid primary key default gen_random_uuid(),
  responsible_user_id uuid not null unique references responsible_users(id) on delete cascade, -- R1.6
  name text not null,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  name text not null,
  member_type text not null check (member_type in ('PARENT','CHILD','DEPENDENT')),
  avatar_url text,
  color text,
  birth_year int,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table task_templates (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  title text not null,
  description text,
  assigned_member_id uuid references family_members(id),
  points int not null default 0 check (points >= 0),
  priority text not null default 'MEDIUM' check (priority in ('LOW','MEDIUM','HIGH','URGENT')),
  recurrence_type text not null check (recurrence_type in ('DAILY','WEEKDAYS','WEEKLY','CUSTOM')),
  recurrence_config jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  template_id uuid references task_templates(id) on delete set null,
  title text not null,
  description text,
  assigned_member_id uuid references family_members(id),
  created_by_user_id uuid not null references responsible_users(id),
  status text not null default 'TODO' check (status in ('BACKLOG','TODO','WORKING','DONE')),
  priority text not null default 'MEDIUM' check (priority in ('LOW','MEDIUM','HIGH','URGENT')),
  points int not null default 0 check (points >= 0),
  due_date date,
  due_time text,
  week_start date,
  carried_from_task_id uuid references tasks(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table task_completions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null unique references tasks(id) on delete cascade,  -- R9.1 / R28.2: one completion per task
  family_id uuid not null references families(id) on delete cascade,
  completed_by_user_id uuid not null references responsible_users(id),
  completed_by_member_id uuid not null references family_members(id),
  completed_at timestamptz not null default now()
);

create table points_transactions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  member_id uuid not null references family_members(id),
  task_id uuid references tasks(id) on delete set null,
  points int not null,
  transaction_type text not null
    check (transaction_type in ('TASK_COMPLETION','MANUAL_ADJUSTMENT','REVERSAL','REDEMPTION')), -- R18.12
  created_at timestamptz not null default now()
);

create table awards (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id) on delete cascade,
  title text not null,
  description text,
  points_cost int not null default 0 check (points_cost >= 0),
  icon text not null default '🎁',
  color text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
