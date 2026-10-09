-- 003_rls.sql
-- Family Task Board — Row-Level Security (Supabase Postgres).
--
-- RLS is enabled on EVERY application table (R23.1) so PostgreSQL is a second,
-- independent family-isolation guarantee behind the API's in-code ownership
-- checks (defense in depth). The ownership chain is always:
--
--   auth.uid()
--     -> responsible_users.auth_user_id
--     -> responsible_users.id
--     -> families.responsible_user_id
--     -> family_id
--
-- The current_family_id() helper centralizes that resolution so every
-- family-scoped policy reads the same way. It is `language sql stable`: pure,
-- read-only, and safe for the planner to treat as constant within a statement.
--
-- Policies are written for the `authenticated` role (user JWTs forwarded by the
-- user-scoped client). The `service_role` key BYPASSES RLS by design and needs
-- no policies — it is the sole writer of the points ledger.
--
-- Ledger-write denial (R23.6): task_completions and points_transactions get a
-- family-scoped SELECT policy but NO insert/update/delete policy for the user
-- role. With RLS enabled and no matching policy, PostgreSQL DENIES the write,
-- so a client holding a user JWT literally cannot fabricate completions or
-- points. All ledger writes happen through SECURITY DEFINER RPCs invoked by the
-- service-role client after the backend verifies ownership in code.
--
-- Requirements: R23.1 (RLS on every table), R23.6 (ledger point-manipulation
-- guard), R28.1 (migrations).

-- ---------------------------------------------------------------------------
-- Ownership helper
-- ---------------------------------------------------------------------------

-- Resolve the family id owned by the currently authenticated user. Returns
-- NULL when the user has no responsible_user row or no family yet, in which
-- case every `= current_family_id()` predicate is NULL (not true) and the row
-- is excluded — the correct fail-closed behavior.
create function current_family_id() returns uuid language sql stable as $$
  select f.id
  from families f
  join responsible_users r on r.id = f.responsible_user_id
  where r.auth_user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS on every application table (R23.1)
-- ---------------------------------------------------------------------------
alter table responsible_users   enable row level security;
alter table families            enable row level security;
alter table family_members      enable row level security;
alter table task_templates      enable row level security;
alter table tasks               enable row level security;
alter table task_completions    enable row level security;
alter table points_transactions enable row level security;
alter table awards              enable row level security;

-- ---------------------------------------------------------------------------
-- responsible_users: self only — keyed on auth_user_id = auth.uid()
-- (No DELETE policy: the row is removed only via auth.users ON DELETE CASCADE.)
-- ---------------------------------------------------------------------------
create policy responsible_users_select on responsible_users
  for select to authenticated
  using (auth_user_id = auth.uid());

create policy responsible_users_insert on responsible_users
  for insert to authenticated
  with check (auth_user_id = auth.uid());

create policy responsible_users_update on responsible_users
  for update to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- families: keyed on the owning responsible_user of the current auth.uid()
-- ---------------------------------------------------------------------------
create policy families_select on families
  for select to authenticated
  using (responsible_user_id = (select id from responsible_users where auth_user_id = auth.uid()));

create policy families_insert on families
  for insert to authenticated
  with check (responsible_user_id = (select id from responsible_users where auth_user_id = auth.uid()));

create policy families_update on families
  for update to authenticated
  using (responsible_user_id = (select id from responsible_users where auth_user_id = auth.uid()))
  with check (responsible_user_id = (select id from responsible_users where auth_user_id = auth.uid()));

create policy families_delete on families
  for delete to authenticated
  using (responsible_user_id = (select id from responsible_users where auth_user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- family_members: full owner-scoped CRUD via current_family_id()
-- ---------------------------------------------------------------------------
create policy family_members_select on family_members
  for select to authenticated
  using (family_id = current_family_id());

create policy family_members_insert on family_members
  for insert to authenticated
  with check (family_id = current_family_id());

create policy family_members_update on family_members
  for update to authenticated
  using (family_id = current_family_id())
  with check (family_id = current_family_id());

create policy family_members_delete on family_members
  for delete to authenticated
  using (family_id = current_family_id());

-- ---------------------------------------------------------------------------
-- task_templates: full owner-scoped CRUD via current_family_id()
-- ---------------------------------------------------------------------------
create policy task_templates_select on task_templates
  for select to authenticated
  using (family_id = current_family_id());

create policy task_templates_insert on task_templates
  for insert to authenticated
  with check (family_id = current_family_id());

create policy task_templates_update on task_templates
  for update to authenticated
  using (family_id = current_family_id())
  with check (family_id = current_family_id());

create policy task_templates_delete on task_templates
  for delete to authenticated
  using (family_id = current_family_id());

-- ---------------------------------------------------------------------------
-- tasks: full owner-scoped CRUD via current_family_id()
-- ---------------------------------------------------------------------------
create policy tasks_select on tasks
  for select to authenticated
  using (family_id = current_family_id());

create policy tasks_insert on tasks
  for insert to authenticated
  with check (family_id = current_family_id());

create policy tasks_update on tasks
  for update to authenticated
  using (family_id = current_family_id())
  with check (family_id = current_family_id());

create policy tasks_delete on tasks
  for delete to authenticated
  using (family_id = current_family_id());

-- ---------------------------------------------------------------------------
-- awards: full owner-scoped CRUD via current_family_id()
-- ---------------------------------------------------------------------------
create policy awards_select on awards
  for select to authenticated
  using (family_id = current_family_id());

create policy awards_insert on awards
  for insert to authenticated
  with check (family_id = current_family_id());

create policy awards_update on awards
  for update to authenticated
  using (family_id = current_family_id())
  with check (family_id = current_family_id());

create policy awards_delete on awards
  for delete to authenticated
  using (family_id = current_family_id());

-- ---------------------------------------------------------------------------
-- Points ledger: READ family-scoped, WRITE denied for the user role (R23.6)
-- ---------------------------------------------------------------------------
-- Reads stay family-scoped so the frontend can render the dashboard, points
-- history, and leaderboard directly with the user JWT. NO insert/update/delete
-- policy is defined, so with RLS enabled those writes are denied for the
-- authenticated role — the ledger is written only by the service role through
-- the SECURITY DEFINER RPCs. This is the point-manipulation guard.

create policy task_completions_select on task_completions
  for select to authenticated
  using (family_id = current_family_id());

create policy points_transactions_select on points_transactions
  for select to authenticated
  using (family_id = current_family_id());
