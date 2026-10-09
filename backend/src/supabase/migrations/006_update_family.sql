-- 006_update_family.sql
-- Family Task Board — atomic family-profile update RPC (Supabase Postgres).
--
-- The frontend treats the household as a single "family" object, but the
-- backend splits that object across two tables: household data (name,
-- avatar_url) lives on `families`, while the responsible adult's data
-- (relationship, display name) lives on `responsible_users` (see the design's
-- "responsible_users / families → single frontend 'family' object"). A
-- `PATCH /api/v1/family` therefore has to touch BOTH tables.
--
-- The Supabase JS client has no multi-statement transaction primitive: two
-- separate `.update()` calls are two HTTP round trips that cannot roll back
-- together, so a failure between them would leave the profile half-updated
-- (families changed, responsible_users not, or vice versa). To keep the two
-- writes ALL-OR-NOTHING (R2.2) this is implemented as a single plpgsql
-- function whose body runs in ONE implicit transaction on the database — both
-- updates commit or roll back together. This mirrors the atomic-RPC approach
-- already used for completion/reopen/redemption in 004_functions.sql.
--
-- SECURITY DEFINER + pinned search_path: consistent with the other RPCs. The
-- backend derives `p_family_id`/`p_responsible_user_id` from the verified
-- session context (never from the request) and enforces ownership before
-- calling, so the function trusts its arguments.
--
-- Partial-update semantics: every column argument is paired with a boolean
-- `p_set_*` flag. A caller passing `p_set_name = false` leaves `families.name`
-- untouched; passing `p_set_name = true` writes `p_name` (which may be NULL for
-- a nullable column). This lets the service forward exactly the fields present
-- in the PATCH body and nothing else. `families.name` is NOT NULL, so the
-- service only sets it when the client supplied a value.
--
-- Requirements: R2.2 (atomic routing of name/avatar_url → families and
-- relationship/responsible_name → responsible_users), R2.4 (family_id derived),
-- R28.1 (migrations).

create function update_family(
  p_family_id uuid,
  p_responsible_user_id uuid,
  p_set_name boolean,
  p_name text,
  p_set_avatar_url boolean,
  p_avatar_url text,
  p_set_relationship boolean,
  p_relationship text,
  p_set_responsible_name boolean,
  p_responsible_name text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Household fields → families. Only overwrite the columns the caller flagged.
  if p_set_name or p_set_avatar_url then
    update families
    set
      name = case when p_set_name then p_name else name end,
      avatar_url = case when p_set_avatar_url then p_avatar_url else avatar_url end
    where id = p_family_id;
  end if;

  -- Responsible-adult fields → responsible_users. `responsible_name` maps to
  -- the `name` column.
  if p_set_relationship or p_set_responsible_name then
    update responsible_users
    set
      relationship = case when p_set_relationship then p_relationship else relationship end,
      name = case when p_set_responsible_name then p_responsible_name else name end
    where id = p_responsible_user_id;
  end if;
end $$;
