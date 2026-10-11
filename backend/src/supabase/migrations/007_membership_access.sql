-- Apply once, after 006. Abort on identity collisions; never choose a winner.
begin;
create table app_users (
 id uuid primary key default gen_random_uuid(),
 auth_user_id uuid not null unique references auth.users(id) on delete restrict,
 display_name text, avatar_url text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table responsible_users drop constraint responsible_users_auth_user_id_fkey;
alter table responsible_users add foreign key(auth_user_id) references auth.users(id) on delete restrict;
alter table families drop constraint families_responsible_user_id_fkey;
alter table families add foreign key(responsible_user_id) references responsible_users(id) on delete restrict;
alter table family_members add unique(id,family_id);
create table family_memberships (
 id uuid primary key default gen_random_uuid(), family_id uuid not null references families(id) on delete restrict,
 app_user_id uuid unique references app_users(id) on delete restrict,
 member_id uuid unique, role text not null check(role in ('OWNER','MANAGER','MEMBER')),
 status text not null check(status in ('PROVISIONED','ACTIVE','REVOKED')),
 login_email text, normalized_email text unique,
 access_version integer not null default 1 check(access_version>0),
 claimed_at timestamptz, revoked_at timestamptz,
 created_by_app_user_id uuid references app_users(id), updated_by_app_user_id uuid references app_users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(member_id,family_id) references family_members(id,family_id) on delete restrict,
 check((role='OWNER' and member_id is null and app_user_id is not null) or (role<>'OWNER' and member_id is not null)),
 check(status<>'ACTIVE' or app_user_id is not null),
 check(role='OWNER' or (login_email is not null and normalized_email is not null)),
 check(normalized_email is not distinct from lower(btrim(login_email)))
);
create unique index one_owner_per_family on family_memberships(family_id) where role='OWNER';
create index membership_family on family_memberships(family_id);
create table access_audit_events (
 id uuid primary key default gen_random_uuid(), family_id uuid not null references families(id),
 actor_app_user_id uuid not null references app_users(id), membership_id uuid not null references family_memberships(id),
 action text not null, previous_role text, new_role text, previous_status text, new_status text,
 correlation_id text, created_at timestamptz not null default now()
);
create table membership_email_changes (
 id uuid primary key default gen_random_uuid(), membership_id uuid not null references family_memberships(id),
 normalized_email text not null, initiated_by_app_user_id uuid not null references app_users(id),
 expected_app_user_id uuid not null references app_users(id), token_hash text not null unique,
 expires_at timestamptz not null, completed_at timestamptz, canceled_at timestamptz,
 created_at timestamptz not null default now()
);
create unique index pending_email_change on membership_email_changes(membership_id) where completed_at is null and canceled_at is null;
-- Audit records are append-only, including for privileged application clients.
create function prevent_access_audit_rewrite() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin raise exception 'FORBIDDEN'; end $$;
create trigger access_audit_immutable before update or delete on access_audit_events for each row execute function prevent_access_audit_rewrite();
-- Owner emails come from provider-confirmed identities, never editable profile metadata.
insert into app_users(auth_user_id,display_name,avatar_url)
 select auth_user_id,name,avatar_url from responsible_users;
insert into family_memberships(family_id,app_user_id,role,status,login_email,normalized_email,claimed_at,created_by_app_user_id)
 select f.id,u.id,'OWNER','ACTIVE', case when a.email_confirmed_at is not null then a.email end,
 case when a.email_confirmed_at is not null then lower(btrim(a.email)) end,now(),u.id
 from families f join responsible_users r on r.id=f.responsible_user_id
 join app_users u on u.auth_user_id=r.auth_user_id join auth.users a on a.id=r.auth_user_id;
alter table tasks add created_by_app_user_id uuid references app_users(id) on delete restrict;
alter table tasks alter column created_by_user_id drop not null;
update tasks t set created_by_app_user_id=u.id from responsible_users r join app_users u on u.auth_user_id=r.auth_user_id where t.created_by_user_id=r.id;
alter table tasks alter column created_by_app_user_id set not null;
alter table task_completions add completed_by_app_user_id uuid references app_users(id) on delete restrict;
alter table task_completions alter column completed_by_user_id drop not null;
update task_completions t set completed_by_app_user_id=u.id from responsible_users r join app_users u on u.auth_user_id=r.auth_user_id where t.completed_by_user_id=r.id;
alter table task_completions alter column completed_by_app_user_id set not null;

create function access_actor(p_auth uuid,p_family uuid,p_manage boolean default true) returns family_memberships
language plpgsql security definer set search_path=public,pg_temp as $$
declare m family_memberships;
begin
 perform 1 from families where id=p_family for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select fm.* into m from family_memberships fm join app_users u on u.id=fm.app_user_id where u.auth_user_id=p_auth and fm.family_id=p_family for update of fm;
 if not found then raise exception 'FORBIDDEN'; end if;
 if m.status<>'ACTIVE' or (m.member_id is not null and not exists(select 1 from family_members where id=m.member_id and active)) then raise exception 'ACCESS_REVOKED'; end if;
 if p_manage and m.role not in ('OWNER','MANAGER') then raise exception 'FORBIDDEN'; end if;
 perform set_config('app.actor',m.app_user_id::text,true);
 return m;
end $$;
create function audit_access(p_actor uuid,p_id uuid,p_action text,p_old_role text,p_old_status text,p_correlation text) returns void
language sql security definer set search_path=public,pg_temp as $$
 insert into access_audit_events(family_id,actor_app_user_id,membership_id,action,previous_role,new_role,previous_status,new_status,correlation_id)
 select family_id,p_actor,id,p_action,p_old_role,role,p_old_status,status,p_correlation from family_memberships where id=p_id;
$$;
create function membership_owner_check() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if tg_op='UPDATE' and old.role='OWNER' and (new.role<>old.role or new.status<>'ACTIVE' or new.family_id<>old.family_id or new.app_user_id is distinct from old.app_user_id) then raise exception 'FORBIDDEN'; end if;
 if new.role='OWNER' and not exists(select 1 from families f join responsible_users r on r.id=f.responsible_user_id join app_users u on u.auth_user_id=r.auth_user_id where f.id=new.family_id and u.id=new.app_user_id) then raise exception 'FORBIDDEN'; end if;
 return new;
end $$;
create trigger owner_membership_protection before insert or update on family_memberships for each row execute function membership_owner_check();

create function resolve_membership(p_auth uuid,p_email text default null,p_name text default null,p_avatar text default null,p_claim boolean default true) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare u app_users; m family_memberships; v_email text:=lower(btrim(p_email));
begin
 insert into app_users(auth_user_id,display_name,avatar_url) values(p_auth,p_name,p_avatar) on conflict(auth_user_id) do nothing;
 select * into u from app_users where auth_user_id=p_auth for update;
 select * into m from family_memberships where app_user_id=u.id;
 if not found and p_claim and v_email is not null then
  select * into m from family_memberships where normalized_email=v_email for update;
  if found then
   if m.app_user_id is not null and m.app_user_id<>u.id then raise exception 'ACCESS_CONFLICT'; end if;
   if m.status='PROVISIONED' and exists(select 1 from family_members where id=m.member_id and active) then
    update family_memberships set app_user_id=u.id,status='ACTIVE',claimed_at=now(),access_version=access_version+1,updated_at=now() where id=m.id returning * into m;
    perform audit_access(u.id,m.id,'CLAIM',m.role,'PROVISIONED',null);
   end if;
  end if;
 end if;
 if m.id is null then
  if exists(select 1 from responsible_users where auth_user_id=p_auth) then raise exception 'OWNER_MIGRATION_REQUIRED'; end if;
  return jsonb_build_object('user',to_jsonb(u),'membership',null,'state','NO_ACCESS');
 end if;
 if m.app_user_id is distinct from u.id or m.status<>'ACTIVE' or (m.member_id is not null and not exists(select 1 from family_members where id=m.member_id and active)) then
  return jsonb_build_object('user',to_jsonb(u),'membership',null,'state','REVOKED');
 end if;
 return jsonb_build_object('user',to_jsonb(u),'membership',to_jsonb(m),'state','READY');
exception when unique_violation then raise exception 'ACCESS_CONFLICT';
end $$;

create function set_member_access(p_auth uuid,p_family uuid,p_member uuid,p_input jsonb,p_correlation text default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare actor family_memberships; m family_memberships; old_role text; old_status text; email text; role_value text;
begin
 actor:=access_actor(p_auth,p_family);
 perform 1 from family_members where id=p_member and family_id=p_family for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into m from family_memberships where member_id=p_member for update;
 if coalesce(m.access_version,0)<>(p_input->>'expectedVersion')::integer then raise exception 'ACCESS_VERSION_CONFLICT'; end if;
 if m.role='OWNER' then raise exception 'FORBIDDEN'; end if;
 old_role:=m.role; old_status:=m.status;
 if coalesce((p_input->>'enabled')::boolean,false) then
  if not exists(select 1 from family_members where id=p_member and active) then raise exception 'VALIDATION'; end if;
  email:=btrim(coalesce(p_input->>'email',m.login_email)); role_value:=coalesce(p_input->>'role',m.role,'MEMBER');
  if email is null or length(email)>254 or email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or role_value not in ('MEMBER','MANAGER') then raise exception 'VALIDATION'; end if;
  if m.app_user_id is not null and lower(btrim(email))<>m.normalized_email then raise exception 'EMAIL_CHANGE_REQUIRED'; end if;
  if m.id is null then
   insert into family_memberships(family_id,member_id,role,status,login_email,normalized_email,created_by_app_user_id,updated_by_app_user_id)
   values(p_family,p_member,role_value,'PROVISIONED',btrim(email),lower(btrim(email)),actor.app_user_id,actor.app_user_id) returning * into m;
  else
   update membership_email_changes set canceled_at=now() where membership_id=m.id and completed_at is null and canceled_at is null;
   update family_memberships set role=role_value,login_email=btrim(email),normalized_email=lower(btrim(email)),status=case when app_user_id is null then 'PROVISIONED' else 'ACTIVE' end,
    revoked_at=null,access_version=access_version+1,updated_by_app_user_id=actor.app_user_id,updated_at=now() where id=m.id returning * into m;
  end if;
 elsif m.id is not null then
  update membership_email_changes set canceled_at=now() where membership_id=m.id and completed_at is null and canceled_at is null;
  update family_memberships set status='REVOKED',revoked_at=now(),access_version=access_version+1,updated_by_app_user_id=actor.app_user_id,updated_at=now() where id=m.id returning * into m;
 else return null;
 end if;
 perform audit_access(actor.app_user_id,m.id,'PROVISION_OR_UPDATE',old_role,old_status,p_correlation);
 return to_jsonb(m);
exception when unique_violation then raise exception 'ACCESS_CONFLICT';
end $$;

-- A single whitelisted mutation transaction covers every existing CRUD writer.
create function authorized_resource_write(p_auth uuid,p_family uuid,p_table text,p_operation text,p_id uuid,p_data jsonb,p_correlation text default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare actor family_memberships; allowed text[]; keys text[]; columns_sql text; values_sql text; assignments text; item jsonb; row_json jsonb; result jsonb:='[]'; access_input jsonb; member uuid; owner_id uuid;
begin
 actor:=access_actor(p_auth,p_family);
 if p_table not in ('tasks','family_members','task_templates','awards') or p_operation not in ('insert','update','delete') or (p_operation='delete' and p_table<>'tasks') then raise exception 'FORBIDDEN'; end if;
 allowed:=case p_table when 'tasks' then array['title','description','assigned_member_id','points','priority','status','due_date','due_time','week_start','template_id','carried_from_task_id']
 when 'family_members' then array['name','member_type','avatar_url','color','birth_year','active']
 when 'task_templates' then array['title','description','assigned_member_id','points','priority','recurrence_type','recurrence_config','active']
 else array['title','description','points_cost','icon','color','active'] end;
 if p_operation<>'insert' then
  execute format('select to_jsonb(t) from public.%I t where id=$1 and family_id=$2 for update',p_table) into row_json using p_id,p_family;
  if row_json is null then raise exception 'NOT_FOUND'; end if;
 end if;
 if p_operation='delete' then execute 'delete from public.tasks where id=$1 and family_id=$2' using p_id,p_family; return result; end if;
 for item in select value from jsonb_array_elements(case when jsonb_typeof(p_data)='array' then p_data else jsonb_build_array(p_data) end) loop
  if item ? 'family_id' and item->>'family_id'<>p_family::text then raise exception 'NOT_FOUND'; end if;
  access_input:=item->'access';
  item:=item-'family_id'-'created_by_user_id'-'created_by_app_user_id'-'access';
  select array_agg(key order by key) into keys from jsonb_object_keys(item) key;
  if not coalesce(keys<@allowed,true) then raise exception 'VALIDATION'; end if;
  if item->>'assigned_member_id' is not null and not exists(select 1 from family_members where id=(item->>'assigned_member_id')::uuid and family_id=p_family) then raise exception 'VALIDATION'; end if;
  if item->>'template_id' is not null and not exists(select 1 from task_templates where id=(item->>'template_id')::uuid and family_id=p_family) then raise exception 'VALIDATION'; end if;
  if item->>'carried_from_task_id' is not null and not exists(select 1 from tasks where id=(item->>'carried_from_task_id')::uuid and family_id=p_family) then raise exception 'VALIDATION'; end if;
  if p_operation='insert' then
   item:=item||jsonb_build_object('family_id',p_family);
   if p_table='tasks' then
    select r.id into owner_id from responsible_users r join app_users u on u.auth_user_id=r.auth_user_id where u.id=actor.app_user_id;
    item:=item||jsonb_build_object('created_by_app_user_id',actor.app_user_id,'created_by_user_id',owner_id);
   end if;
   select string_agg(format('%I',key),',' order by key),string_agg(format('r.%I',key),',' order by key) into columns_sql,values_sql from jsonb_object_keys(item) key;
   execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) r returning to_jsonb(%I)',p_table,columns_sql,values_sql,p_table,p_table) into row_json using item;
  elsif keys is not null then
   select string_agg(format('%I=r.%I',key,key),',' order by key) into assignments from unnest(keys) key;
   execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I,$1) r where t.id=$2 and t.family_id=$3 returning to_jsonb(t)',p_table,assignments,p_table) into row_json using item,p_id,p_family;
  end if;
  if p_table='family_members' and access_input is not null then
   member:=(row_json->>'id')::uuid;
   perform set_member_access(p_auth,p_family,member,access_input||jsonb_build_object('expectedVersion',0),p_correlation);
  end if;
  result:=result||jsonb_build_array(row_json);
 end loop;
 return result;
end $$;

create function revoke_inactive_member() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare m family_memberships; actor uuid;
begin
 if old.active and not new.active then
  actor:=nullif(current_setting('app.actor',true),'')::uuid;
  select * into m from family_memberships where member_id=new.id for update;
  if m.id is not null then
   update family_memberships set status='REVOKED',access_version=access_version+1,revoked_at=now(),updated_at=now() where id=m.id;
   update membership_email_changes set canceled_at=now() where membership_id=m.id and completed_at is null and canceled_at is null;
   if actor is not null then perform audit_access(actor,m.id,'DEACTIVATE',m.role,m.status,null); end if;
  end if;
 end if;
 return new;
end $$;
create trigger revoke_member_access after update on family_members for each row execute function revoke_inactive_member();

create function authorized_family_action(p_auth uuid,p_family uuid,p_action text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare actor family_memberships; target uuid; member uuid; legacy_actor uuid; result jsonb; owner_id uuid;
begin
 actor:=access_actor(p_auth,p_family);
 target:=coalesce(p_args->>'p_task_id',p_args->>'p_award_id')::uuid;
 if p_action in ('complete_task','reopen_task') and not exists(select 1 from tasks where id=target and family_id=p_family) then raise exception 'NOT_FOUND'; end if;
 if p_action='redeem_award' and not exists(select 1 from awards where id=target and family_id=p_family) then raise exception 'NOT_FOUND'; end if;
 member:=(p_args->>'p_member_id')::uuid;
 if p_action in ('complete_task','redeem_award') then
  perform 1 from family_members where id=member and family_id=p_family and active for update;
  if not found then raise exception 'VALIDATION'; end if;
 end if;
 select r.id into legacy_actor from responsible_users r join app_users u on u.auth_user_id=r.auth_user_id where u.id=actor.app_user_id;
 if p_action='complete_task' then
  -- Canonical actor is installed by the insert trigger inside the old atomic RPC.
  result:=complete_task(target,member,legacy_actor);
 elsif p_action='reopen_task' then result:=reopen_task(target);
 elsif p_action='redeem_award' then result:=redeem_award(target,member,p_family);
 elsif p_action='update_family' then
  select responsible_user_id into owner_id from families where id=p_family;
  perform update_family(p_family,owner_id,(p_args->>'p_set_name')::boolean,p_args->>'p_name',(p_args->>'p_set_avatar_url')::boolean,p_args->>'p_avatar_url',(p_args->>'p_set_relationship')::boolean,p_args->>'p_relationship',(p_args->>'p_set_responsible_name')::boolean,p_args->>'p_responsible_name');
  result:=null;
 else raise exception 'FORBIDDEN'; end if;
 return result;
end $$;
create function canonical_completion_actor() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 new.completed_by_app_user_id:=nullif(current_setting('app.actor',true),'')::uuid;
 if new.completed_by_app_user_id is null then
  select u.id into new.completed_by_app_user_id from app_users u join responsible_users r on r.auth_user_id=u.auth_user_id where r.id=new.completed_by_user_id;
 end if;
 return new;
end $$;
create trigger completion_actor before insert on task_completions for each row execute function canonical_completion_actor();

create function begin_membership_email_change(p_auth uuid,p_family uuid,p_member uuid,p_email text,p_version integer,p_hash text,p_correlation text) returns timestamptz
language plpgsql security definer set search_path=public,pg_temp as $$
declare actor family_memberships; m family_memberships; expiry timestamptz:=now()+interval '24 hours';
begin
 actor:=access_actor(p_auth,p_family);
 select * into m from family_memberships where member_id=p_member and family_id=p_family for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 if m.access_version<>p_version then raise exception 'ACCESS_VERSION_CONFLICT'; end if;
 if m.app_user_id is null or m.role='OWNER' then raise exception 'EMAIL_CHANGE_REQUIRED'; end if;
 if exists(select 1 from family_memberships where normalized_email=lower(btrim(p_email)) and id<>m.id) then raise exception 'ACCESS_CONFLICT'; end if;
 update membership_email_changes set canceled_at=now() where membership_id=m.id and canceled_at is null and completed_at is null;
 insert into membership_email_changes(membership_id,normalized_email,initiated_by_app_user_id,expected_app_user_id,token_hash,expires_at) values(m.id,lower(btrim(p_email)),actor.app_user_id,m.app_user_id,p_hash,expiry);
 update family_memberships set status='REVOKED',revoked_at=now(),access_version=access_version+1,updated_at=now() where id=m.id;
 perform audit_access(actor.app_user_id,m.id,'EMAIL_CHANGE_STARTED',m.role,m.status,p_correlation);
 return expiry;
end $$;
create function confirm_membership_email_change(p_auth uuid,p_email text,p_hash text,p_correlation text) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare c membership_email_changes; m family_memberships; actor uuid;
begin
 select * into c from membership_email_changes where token_hash=p_hash;
 if not found then raise exception 'INVALID_EMAIL_CHANGE'; end if;
 select * into m from family_memberships where id=c.membership_id;
 perform 1 from families where id=m.family_id for update;
 select * into m from family_memberships where id=c.membership_id for update;
 select * into c from membership_email_changes where id=c.id for update;
 select id into actor from app_users where auth_user_id=p_auth;
 if actor is distinct from c.expected_app_user_id or m.app_user_id is distinct from actor or c.completed_at is not null or c.canceled_at is not null or c.expires_at<=clock_timestamp() or c.normalized_email is distinct from lower(btrim(p_email)) or not exists(select 1 from family_members where id=m.member_id and active) then raise exception 'INVALID_EMAIL_CHANGE'; end if;
 update family_memberships set login_email=btrim(p_email),normalized_email=c.normalized_email,status='ACTIVE',revoked_at=null,access_version=access_version+1,updated_at=now() where id=m.id;
 update membership_email_changes set completed_at=now() where id=c.id;
 perform audit_access(actor,m.id,'EMAIL_CHANGE_CONFIRMED',m.role,m.status,p_correlation);
exception when unique_violation then raise exception 'ACCESS_CONFLICT';
end $$;

-- Browser access: no raw identities, mutation privileges or shared private roster.
create function current_access() returns family_memberships language sql stable security definer set search_path=public,pg_temp as $$
 select m from family_memberships m join app_users u on u.id=m.app_user_id where u.auth_user_id=auth.uid() and m.status='ACTIVE' and (m.member_id is null or exists(select 1 from family_members where id=m.member_id and active));
$$;
create or replace function current_family_id() returns uuid language sql stable security definer set search_path=public,pg_temp as $$ select (current_access()).family_id $$;
do $$ declare r record; begin
 for r in select schemaname,tablename,policyname from pg_policies where schemaname='public' and tablename in ('responsible_users','families','family_members','task_templates','tasks','task_completions','points_transactions','awards') loop execute format('drop policy %I on public.%I',r.policyname,r.tablename); end loop;
end $$;
alter table app_users enable row level security;
alter table family_memberships enable row level security;
alter table access_audit_events enable row level security;
alter table membership_email_changes enable row level security;
revoke all on app_users,family_memberships,access_audit_events,membership_email_changes from public,anon,authenticated;
revoke insert,update,delete on responsible_users,families,family_members,task_templates,tasks,task_completions,points_transactions,awards from anon,authenticated;
revoke select on tasks,families,responsible_users from anon,authenticated;
create policy roster_manager on family_members for select to authenticated using(family_id=current_family_id() and (current_access()).role in ('OWNER','MANAGER'));
create policy templates_manager on task_templates for select to authenticated using(family_id=current_family_id() and (current_access()).role in ('OWNER','MANAGER'));
create policy awards_family on awards for select to authenticated using(family_id=current_family_id());
create policy own_points on points_transactions for select to authenticated using(family_id=current_family_id() and ((current_access()).role in ('OWNER','MANAGER') or member_id=(current_access()).member_id));
revoke select on task_completions from authenticated;
grant select(id,task_id,family_id,completed_by_member_id,completed_at) on task_completions to authenticated;
create policy own_completions on task_completions for select to authenticated using(family_id=current_family_id() and ((current_access()).role in ('OWNER','MANAGER') or completed_by_member_id=(current_access()).member_id));
-- Existing RPCs never remain callable by browser roles (including overloads).
do $$ declare r record; begin
 for r in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('access_actor','audit_access','resolve_membership','set_member_access','authorized_resource_write','revoke_inactive_member','authorized_family_action','begin_membership_email_change','confirm_membership_email_change','current_access','current_family_id','complete_task','reopen_task','redeem_award','update_family') loop
  execute format('revoke all on function %s from public,anon,authenticated',r.signature);
  execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
grant execute on function current_access(),current_family_id() to authenticated;
grant all on app_users,family_memberships,access_audit_events,membership_email_changes to service_role;
commit;
