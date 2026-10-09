-- 004_functions.sql
-- Family Task Board — atomic RPC functions + updated_at trigger (Supabase Postgres).
--
-- The Supabase JS client has no multi-statement transaction primitive: each
-- statement is a separate HTTP round trip that cannot roll back with the
-- others. Completion, reopen, and redemption each must insert ledger rows and
-- mutate task state ALL-OR-NOTHING. So they are implemented as plpgsql
-- functions: a single function body runs in ONE implicit transaction on the
-- database — every insert/update inside it commits or rolls back together.
-- This is what satisfies the atomicity requirements R10.4/R10.5 (completion),
-- R11.6 (reopen), and R18.11 (redemption).
--
-- Concurrency: `SELECT ... FOR UPDATE` takes a row lock so two concurrent
-- callers serialize on the same task / member row. Combined with the
-- UNIQUE(task_id) constraint on task_completions this gives correct behavior
-- under concurrent requests (R9.4 duplicate completion, R11.9 duplicate reopen,
-- R18.11 concurrent overspend).
--
-- SECURITY DEFINER: these functions are the ONLY writers of the points ledger
-- (task_completions / points_transactions), which the user-scoped role is
-- denied from writing by RLS (see 003_rls.sql). Running them as the definer
-- lets the service-role client invoke them while the backend enforces family
-- ownership in code BEFORE calling. Each function pins `search_path` to a fixed
-- schema list so an attacker cannot shadow referenced objects via a mutable
-- search_path — a standard SECURITY DEFINER hardening step.
--
-- Named exceptions raised here (`NOT_FOUND`, `TASK_ALREADY_COMPLETED`,
-- `INSUFFICIENT_POINTS`) are caught by the repository layer and mapped to the
-- shared error classes / Error_Contract codes.
--
-- Requirements: R10.4, R10.5 (atomic completion), R11.6, R11.9 (atomic reopen),
-- R18.11 (atomic balance-guarded redemption), R9.4 (concurrent duplicate
-- completion), R11.2/R11.3/R11.5 (reversal semantics), R18.5/R18.6/R18.7
-- (redemption ledger + balance guard), R28.1 (migrations).

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
-- One shared trigger function refreshes updated_at on every write. It touches
-- only NEW, so it is agnostic to the table it fires on and can be attached to
-- all tables that carry an updated_at column. task_completions and
-- points_transactions are append-only ledgers with no updated_at column, so no
-- trigger is attached to them.

create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger trg_responsible_users_updated_at
  before update on responsible_users
  for each row execute function set_updated_at();

create trigger trg_families_updated_at
  before update on families
  for each row execute function set_updated_at();

create trigger trg_family_members_updated_at
  before update on family_members
  for each row execute function set_updated_at();

create trigger trg_task_templates_updated_at
  before update on task_templates
  for each row execute function set_updated_at();

create trigger trg_tasks_updated_at
  before update on tasks
  for each row execute function set_updated_at();

create trigger trg_awards_updated_at
  before update on awards
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- complete_task — atomic completion (R10.4/R10.5, R9.4)
-- ---------------------------------------------------------------------------
-- Preconditions the caller (backend service) has already verified: the task
-- and the member belong to the session family, and the member is active.
--
-- Steps, all in one transaction:
--   1. Lock the task row FOR UPDATE (serializes concurrent completions).
--   2. NOT_FOUND if the task does not exist.
--   3. TASK_ALREADY_COMPLETED if the task is already DONE.
--   4. Insert the task_completion. UNIQUE(task_id) is the hard backstop: a
--      racing second request that passed the status check still fails the
--      insert, caught below and reported as TASK_ALREADY_COMPLETED (R9.4).
--   5. Only when task.points > 0, insert the TASK_COMPLETION ledger row
--      (R10.2); a 0-point completion creates no ledger row (R10.3).
--   6. Flip the task to DONE.
--   7. Return a jsonb summary for the service to shape the HTTP response.
create function complete_task(
  p_task_id uuid,
  p_member_id uuid,
  p_responsible_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task tasks;
  v_now timestamptz := now();
  v_awarded int := 0;
begin
  select * into v_task from tasks where id = p_task_id for update;  -- lock row
  if not found then
    raise exception 'NOT_FOUND';
  end if;
  if v_task.status = 'DONE' then
    raise exception 'TASK_ALREADY_COMPLETED';
  end if;

  insert into task_completions(
    task_id, family_id, completed_by_user_id, completed_by_member_id, completed_at
  ) values (
    p_task_id, v_task.family_id, p_responsible_user_id, p_member_id, v_now
  );  -- UNIQUE(task_id) guards duplicates (R9.1)

  if v_task.points > 0 then
    insert into points_transactions(family_id, member_id, task_id, points, transaction_type)
    values (v_task.family_id, p_member_id, p_task_id, v_task.points, 'TASK_COMPLETION');
    v_awarded := v_task.points;
  end if;

  update tasks set status = 'DONE' where id = p_task_id;

  return jsonb_build_object(
    'status', 'DONE',
    'completedAt', v_now,
    'completedByMemberId', p_member_id,
    'awarded', v_awarded
  );
exception
  when unique_violation then
    -- A concurrent request already inserted the completion for this task_id
    -- (R9.4). The whole transaction rolls back; report the duplicate.
    raise exception 'TASK_ALREADY_COMPLETED';
end $$;

-- ---------------------------------------------------------------------------
-- reopen_task — atomic reopen + reversal (R11.6, R11.9)
-- ---------------------------------------------------------------------------
-- Preconditions the caller has verified: the task belongs to the session
-- family. The service maps a non-DONE task to 422 before calling, but the RPC
-- re-checks defensively so it is correct even if invoked directly.
--
-- Steps, all in one transaction:
--   1. Lock the task row FOR UPDATE (serializes concurrent reopens → R11.9).
--   2. NOT_FOUND if the task does not exist.
--   3. NOT_DONE if the task is not currently DONE (defensive re-check).
--   4. Delete the task_completion (there is at most one — UNIQUE(task_id)).
--      Capturing the member id lets the REVERSAL credit the right member.
--   5. Find the original TASK_COMPLETION ledger row for this task. When it
--      awarded > 0 points, insert a REVERSAL of the negated amount and KEEP the
--      original row (R11.2/R11.3). When it awarded 0 (or there was none),
--      create NO reversal and reversedPoints is 0 (R11.5).
--   6. Flip the task back to TODO; this also re-arms the UNIQUE(task_id)
--      constraint so the task can be completed again (R11.7).
--   7. Return the new status and the non-negative reversedPoints.
create function reopen_task(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task tasks;
  v_member_id uuid;
  v_original_points int;
  v_reversed int := 0;
begin
  select * into v_task from tasks where id = p_task_id for update;  -- lock row
  if not found then
    raise exception 'NOT_FOUND';
  end if;
  if v_task.status <> 'DONE' then
    raise exception 'NOT_DONE';
  end if;

  -- Remove the single completion, capturing who was credited.
  delete from task_completions
  where task_id = p_task_id
  returning completed_by_member_id into v_member_id;

  -- Original award for this task (positive TASK_COMPLETION row, if any).
  select points into v_original_points
  from points_transactions
  where task_id = p_task_id and transaction_type = 'TASK_COMPLETION'
  order by created_at asc
  limit 1;

  if v_original_points is not null and v_original_points > 0 then
    -- Keep the original row; append the REVERSAL (R11.2/R11.3). The derived
    -- total is allowed to go negative — append-only audit trail (R11.10).
    insert into points_transactions(family_id, member_id, task_id, points, transaction_type)
    values (v_task.family_id, v_member_id, p_task_id, -v_original_points, 'REVERSAL');
    v_reversed := v_original_points;
  end if;

  update tasks set status = 'TODO' where id = p_task_id;

  return jsonb_build_object(
    'status', 'TODO',
    'reversedPoints', v_reversed
  );
end $$;

-- ---------------------------------------------------------------------------
-- redeem_award — atomic balance-guarded redemption (R18.5/R18.6/R18.7/R18.11)
-- ---------------------------------------------------------------------------
-- Preconditions the caller has verified: the award and the member belong to
-- the session family (p_family_id), and the member exists in that family.
--
-- Steps, all in one transaction:
--   1. Lock the member's family_members row FOR UPDATE. The ledger is
--      append-only (no single "balance" row), so this stable per-member row is
--      the serialization point: two concurrent redemptions for the same member
--      take turns, so the second sees the first's deduction and cannot drive
--      the derived total below 0 (R18.11 overspend guard).
--   2. NOT_FOUND if the award does not exist / is outside the family.
--   3. Read points_cost from the STORED award (never from the request) (R18.6).
--   4. Compute the member's derived balance as the SUM of ledger rows (the
--      ledger is the single source of truth — R10.1). COALESCE handles a member
--      with no transactions yet.
--   5. INSUFFICIENT_POINTS if balance < cost — i.e. redeeming would drop the
--      derived total below 0 — and no ledger row is written (R18.7).
--   6. Insert one REDEMPTION ledger row of -cost (R18.5).
--   7. Return the created transaction as jsonb.
create function redeem_award(
  p_award_id uuid,
  p_member_id uuid,
  p_family_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cost int;
  v_balance int;
  v_txn points_transactions;
begin
  -- Serialize concurrent redemptions for this member on a stable row.
  perform 1 from family_members where id = p_member_id for update;

  select points_cost into v_cost
  from awards
  where id = p_award_id and family_id = p_family_id;
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  select coalesce(sum(points), 0) into v_balance
  from points_transactions
  where family_id = p_family_id and member_id = p_member_id;

  if v_balance < v_cost then
    raise exception 'INSUFFICIENT_POINTS';
  end if;

  insert into points_transactions(family_id, member_id, task_id, points, transaction_type)
  values (p_family_id, p_member_id, null, -v_cost, 'REDEMPTION')
  returning * into v_txn;

  return to_jsonb(v_txn);
end $$;
