-- Explicit drafts; no entitlement activation is introduced by this migration.
begin;
alter table families
 add column lifecycle text not null default 'DRAFT' check(lifecycle in ('DRAFT','ESTABLISHED')),
 add column creation_source text not null default 'LEGACY' check(creation_source in ('LEGACY','SELF_SERVICE')),
 add column legacy_access_eligible boolean not null default false,
 add column profile_completed_at timestamptz,
 add column established_at timestamptz;
-- Temporary, explicit compatibility eligibility. Only pre-existing tenants qualify.
update families f set legacy_access_eligible=true,
 lifecycle=case when nullif(btrim(r.name),'') is not null and r.relationship is not null then 'ESTABLISHED' else 'DRAFT' end,
 profile_completed_at=case when nullif(btrim(r.name),'') is not null and r.relationship is not null then now() end,
 established_at=case when nullif(btrim(r.name),'') is not null and r.relationship is not null then now() end
 from responsible_users r where r.id=f.responsible_user_id;
do $$ declare established bigint; drafts bigint; begin
 select count(*) filter(where lifecycle='ESTABLISHED'),count(*) filter(where lifecycle='DRAFT') into established,drafts from families;
 raise notice 'Tenant backfill: % established legacy families, % incomplete legacy drafts',established,drafts;
end $$;
alter table families alter column creation_source set default 'SELF_SERVICE';
create function immutable_tenant_source() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if new.creation_source<>old.creation_source or new.legacy_access_eligible<>old.legacy_access_eligible then raise exception 'FORBIDDEN'; end if;
 return new;
end $$;
create trigger tenant_source_immutable before update on families for each row execute function immutable_tenant_source();
-- Established settings can edit the owner profile too. Keep completion truthful
-- for both entry points, without reverting an established lifecycle.
create function sync_tenant_profile() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare complete boolean:=nullif(btrim(new.name),'') is not null and new.relationship is not null;
begin
 update families set profile_completed_at=case when complete then coalesce(profile_completed_at,now()) end,
 lifecycle=case when complete and creation_source='LEGACY' and legacy_access_eligible then 'ESTABLISHED' else lifecycle end,
 established_at=case when complete and creation_source='LEGACY' and legacy_access_eligible then coalesce(established_at,now()) else established_at end
 where responsible_user_id=new.id;
 return new;
end $$;
create trigger tenant_profile_completion after update of name,relationship on responsible_users for each row execute function sync_tenant_profile();
create table tenant_creation_requests(
 app_user_id uuid not null references app_users(id) on delete restrict,
 request_key uuid not null,
 request_hash text not null,
 family_id uuid not null references families(id) on delete restrict,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(app_user_id,request_key)
);
alter table tenant_creation_requests enable row level security;
revoke all on tenant_creation_requests from public,anon,authenticated;
grant all on tenant_creation_requests to service_role;
-- Future entitlement enforcement replaces this policy; establishment alone is not payment.
create function tenant_product_access(p_family uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce((select profile_completed_at is not null and lifecycle='ESTABLISHED' and creation_source='LEGACY' and legacy_access_eligible from families where id=p_family),false)
$$;
create function tenant_onboarding_result(p_family uuid) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('family',jsonb_build_object('id',f.id,'name',f.name,'avatar_url',f.avatar_url,'responsible_name',r.name,'relationship',r.relationship),
 'lifecycle',f.lifecycle,'profileCompleted',f.profile_completed_at is not null,
 'nextAction',case when f.profile_completed_at is null then 'COMPLETE_PROFILE' when tenant_product_access(f.id) then 'OPEN_DASHBOARD' else 'SUBSCRIBE' end)
 from families f join responsible_users r on r.id=f.responsible_user_id where f.id=p_family
$$;
create function tenant_onboarding(p_auth uuid,p_input jsonb default null) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare m family_memberships; f families; r responsible_users;
begin
 select fm.* into m from family_memberships fm join app_users u on u.id=fm.app_user_id where u.auth_user_id=p_auth;
 if m.id is null or m.role<>'OWNER' or m.status<>'ACTIVE' then raise exception 'FORBIDDEN'; end if;
 select * into f from families where id=m.family_id for update;
 perform 1 from family_memberships where id=m.id and role='OWNER' and status='ACTIVE' for update;
 if not found then raise exception 'FORBIDDEN'; end if;
 if p_input is not null then
  if jsonb_typeof(p_input)<>'object' or p_input - array['name','responsible_name','relationship'] <> '{}'::jsonb
   or (p_input ? 'name' and (jsonb_typeof(p_input->'name')<>'string' or length(btrim(p_input->>'name')) not between 1 and 120))
   or (p_input ? 'responsible_name' and (jsonb_typeof(p_input->'responsible_name')<>'string' or length(btrim(p_input->>'responsible_name')) not between 1 and 120))
   or (p_input ? 'relationship' and (p_input->>'relationship' is null or p_input->>'relationship' not in ('FATHER','MOTHER','GUARDIAN','OTHER')))
   then raise exception 'VALIDATION'; end if;
  update responsible_users set name=case when p_input ? 'responsible_name' then btrim(p_input->>'responsible_name') else name end,
   relationship=coalesce(p_input->>'relationship',relationship),updated_at=now() where id=f.responsible_user_id returning * into r;
  update families set name=case when p_input ? 'name' then btrim(p_input->>'name') else name end,
   profile_completed_at=case when nullif(btrim(r.name),'') is not null and r.relationship is not null then coalesce(profile_completed_at,now()) end,
   lifecycle=case when creation_source='LEGACY' and legacy_access_eligible and nullif(btrim(r.name),'') is not null and r.relationship is not null then 'ESTABLISHED' else lifecycle end,
   established_at=case when creation_source='LEGACY' and legacy_access_eligible and nullif(btrim(r.name),'') is not null and r.relationship is not null then coalesce(established_at,now()) else established_at end,
   updated_at=now() where id=f.id;
 end if;
 return tenant_onboarding_result(f.id);
end $$;
-- Presentation eligibility is server-derived; creation rechecks under locks.
create function tenant_signup_eligible(p_auth uuid,p_email text) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select nullif(btrim(p_email),'') is not null
 and not exists(select 1 from family_memberships m join app_users u on u.id=m.app_user_id where u.auth_user_id=p_auth)
 and not exists(select 1 from family_memberships where normalized_email=lower(btrim(p_email)))
 and not exists(select 1 from responsible_users where auth_user_id=p_auth)
$$;
create function create_tenant(p_auth uuid,p_email text,p_key uuid,p_hash text,p_input jsonb,p_enabled boolean default false) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare u app_users; m family_memberships; prior tenant_creation_requests; owner_id uuid; family_id uuid; v_email text:=lower(btrim(p_email)); created boolean:=false;
begin
 if nullif(v_email,'') is null then raise exception 'EMAIL_VERIFICATION_REQUIRED'; end if;
 if p_key is null or nullif(p_hash,'') is null or jsonb_typeof(p_input)<>'object' or p_input - array['name','responsible_name','relationship'] <> '{}'::jsonb
 or not (p_input ?& array['name','responsible_name','relationship'])
 or jsonb_typeof(p_input->'name')<>'string' or length(btrim(p_input->>'name')) not between 1 and 120
 or jsonb_typeof(p_input->'responsible_name')<>'string' or length(btrim(p_input->>'responsible_name')) not between 1 and 120
 or p_input->>'relationship' is null or p_input->>'relationship' not in ('FATHER','MOTHER','GUARDIAN','OTHER') then raise exception 'VALIDATION'; end if;
 insert into app_users(auth_user_id) values(p_auth) on conflict(auth_user_id) do nothing;
 select * into u from app_users where auth_user_id=p_auth for update;
 select * into prior from tenant_creation_requests where app_user_id=u.id and request_key=p_key;
 if found and prior.request_hash<>p_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
 select * into m from family_memberships where app_user_id=u.id;
 if m.id is not null then
  if m.role<>'OWNER' or m.status<>'ACTIVE' then raise exception 'TENANT_ASSOCIATION_CONFLICT'; end if;
  family_id:=m.family_id;
 else
  -- Existing and revoked mailbox reservations disqualify creation. The unique
  -- normalized_email index also arbitrates concurrent, initially absent rows.
  perform 1 from family_memberships where normalized_email=v_email for update;
  if found or exists(select 1 from responsible_users where auth_user_id=p_auth) then raise exception 'TENANT_ASSOCIATION_CONFLICT'; end if;
  if not p_enabled then raise exception 'SIGNUP_UNAVAILABLE'; end if;
  insert into responsible_users(auth_user_id,email,name,relationship) values(p_auth,v_email,btrim(p_input->>'responsible_name'),p_input->>'relationship') returning id into owner_id;
  insert into families(responsible_user_id,name,creation_source,profile_completed_at) values(owner_id,btrim(p_input->>'name'),'SELF_SERVICE',now()) returning id into family_id;
  insert into family_memberships(family_id,app_user_id,role,status,login_email,normalized_email,claimed_at)
   values(family_id,u.id,'OWNER','ACTIVE',v_email,v_email,now());
  created:=true;
 end if;
 if prior.family_id is not null and prior.family_id<>family_id then raise exception 'TENANT_ASSOCIATION_CONFLICT'; end if;
 insert into tenant_creation_requests(app_user_id,request_key,request_hash,family_id) values(u.id,p_key,p_hash,family_id) on conflict do nothing;
 return tenant_onboarding_result(family_id)||jsonb_build_object('created',created);
exception when unique_violation then raise exception 'TENANT_ASSOCIATION_CONFLICT';
end $$;
create or replace function access_actor(p_auth uuid,p_family uuid,p_manage boolean default true) returns family_memberships
language plpgsql security definer set search_path=public,pg_temp as $$
declare m family_memberships;
begin
 perform 1 from families where id=p_family for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select fm.* into m from family_memberships fm join app_users u on u.id=fm.app_user_id where u.auth_user_id=p_auth and fm.family_id=p_family for update of fm;
 if not found then raise exception 'FORBIDDEN'; end if;
 if m.status<>'ACTIVE' or (m.member_id is not null and not exists(select 1 from family_members where id=m.member_id and active)) then raise exception 'ACCESS_REVOKED'; end if;
 if p_manage and m.role not in ('OWNER','MANAGER') then raise exception 'FORBIDDEN'; end if;
 if not tenant_product_access(p_family) then raise exception 'TENANT_ACCESS_RESTRICTED'; end if;
 perform set_config('app.actor',m.app_user_id::text,true);
 return m;
end $$;
create or replace function current_access() returns family_memberships language sql stable security definer set search_path=public,pg_temp as $$
 select m from family_memberships m join app_users u on u.id=m.app_user_id where u.auth_user_id=auth.uid() and m.status='ACTIVE' and tenant_product_access(m.family_id) and (m.member_id is null or exists(select 1 from family_members where id=m.member_id and active));
$$;
alter function member_view_read(uuid,text,jsonb) rename to member_view_snapshot;
revoke all on function member_view_snapshot(uuid,text,jsonb) from public,anon,authenticated,service_role;
create function member_view_read(p_auth uuid,p_kind text,p_input jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare fid uuid;
begin
 select m.family_id into fid from family_memberships m join app_users u on u.id=m.app_user_id where u.auth_user_id=p_auth and m.status='ACTIVE';
 if fid is null then raise exception 'ACCESS_REVOKED'; end if;
 if not tenant_product_access(fid) then raise exception 'TENANT_ACCESS_RESTRICTED'; end if;
 return member_view_snapshot(p_auth,p_kind,p_input);
end $$;
do $$ declare r record; begin
 for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('sync_tenant_profile','tenant_signup_eligible','tenant_product_access','tenant_onboarding_result','tenant_onboarding','create_tenant','member_view_read','immutable_tenant_source') loop
 execute format('revoke all on function %s from public,anon,authenticated',r.signature);
 execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
commit;
