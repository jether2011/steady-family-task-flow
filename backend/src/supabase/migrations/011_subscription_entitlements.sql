-- Subscription policy is persisted, versioned and shared by SQL/API authorization.
begin;
create table entitlement_policies(
 version text primary key, approved boolean not null, enforcement_enabled boolean not null,
 grace_days integer check(grace_days between 0 and 90),outage_hours integer check(outage_hours between 0 and 168),
 trials_enabled boolean not null default false,legacy_deadline timestamptz,
 price_id text,stripe_mode text check(stripe_mode in ('TEST','LIVE')),merchant text,exception_policy text,
 member_limit integer check(member_limit>0),approval_reference text,created_at timestamptz not null default now(),
 check(not approved or (grace_days is not null and outage_hours is not null and stripe_mode is not null and merchant is not null and price_id is not null and exception_policy='RESTRICT' and approval_reference is not null)),
 check(not enforcement_enabled or (approved and legacy_deadline is not null))
);
insert into entitlement_policies(version,approved,enforcement_enabled) values('bootstrap-legacy-compat',false,false);
create trigger entitlement_policy_immutable before update or delete on entitlement_policies for each row execute function prevent_access_audit_rewrite();
create table entitlement_policy_current(id boolean primary key default true check(id),version text not null references entitlement_policies(version));
insert into entitlement_policy_current values(true,'bootstrap-legacy-compat');
create table entitlement_cohorts(
 family_id uuid primary key references families(id),enforced boolean not null default false,
 legacy_conversion_consumed boolean not null default false,
 legacy_enforcement_started boolean not null default false,legacy_deadline timestamptz,
 exception_until timestamptz,exception_reason text,updated_at timestamptz not null default now()
);
create table family_entitlements(
 family_id uuid primary key references families(id),state text not null check(state in ('DRAFT','ACTIVE','GRACE','READ_ONLY','LEGACY','TRIAL')),
 source text not null check(source in ('NONE','STRIPE','LEGACY_MIGRATION')),
 account_id uuid references billing_accounts(id),subscription_id uuid references billing_subscriptions(id),billing_snapshot_version bigint,
 paid_through timestamptz,trial_ends_at timestamptz,grace_ends_at timestamptz,first_renewal_failure_at timestamptz,
 legacy_ends_at timestamptz,verified_at timestamptz,outage_tolerance_ends_at timestamptz,
 reason text not null,version bigint not null default 1,policy_version text not null references entitlement_policies(version),
 updated_at timestamptz not null default now()
);
create table entitlement_events(
 id uuid primary key default gen_random_uuid(),family_id uuid not null references families(id),
 prior_state jsonb,new_state jsonb not null,operation text not null,outbox_id uuid references billing_change_outbox(id),
 reason text not null,policy_version text not null,created_at timestamptz not null default now()
);
create trigger entitlement_events_immutable before update or delete on entitlement_events for each row execute function prevent_access_audit_rewrite();
create table entitlement_jobs(
 family_id uuid primary key references families(id),due_at timestamptz not null default now(),lease_token uuid,lease_until timestamptz,
 attempts integer not null default 0,safe_error text,updated_at timestamptz not null default now()
);
create index entitlement_jobs_due on entitlement_jobs(due_at);
create table deployment_worker_heartbeats(name text primary key,seen_at timestamptz not null default now());
insert into entitlement_cohorts(family_id,enforced) select id,creation_source='SELF_SERVICE' from families;
insert into family_entitlements(family_id,state,source,reason,policy_version)
 select id,case when creation_source='LEGACY' and legacy_access_eligible then 'LEGACY' else 'DRAFT' end,
 case when creation_source='LEGACY' and legacy_access_eligible then 'LEGACY_MIGRATION' else 'NONE' end,
 case when creation_source='LEGACY' and legacy_access_eligible then 'LEGACY' else 'PAYMENT_PENDING' end,'bootstrap-legacy-compat' from families;
insert into entitlement_events(family_id,new_state,operation,reason,policy_version)
 select family_id,to_jsonb(e),'MIGRATION',reason,policy_version from family_entitlements e;
insert into entitlement_jobs(family_id) select id from families;
create function entitlement_initialize() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into entitlement_cohorts(family_id,enforced) values(new.id,new.creation_source='SELF_SERVICE');
 insert into family_entitlements(family_id,state,source,reason,policy_version) values(new.id,case when new.creation_source='LEGACY' and new.legacy_access_eligible then 'LEGACY' else 'DRAFT' end,case when new.creation_source='LEGACY' and new.legacy_access_eligible then 'LEGACY_MIGRATION' else 'NONE' end,case when new.creation_source='LEGACY' and new.legacy_access_eligible then 'LEGACY' else 'PAYMENT_PENDING' end,(select version from entitlement_policy_current));
 insert into entitlement_jobs(family_id) values(new.id);
 return new;
end $$;
create trigger initialize_entitlement after insert on families for each row execute function entitlement_initialize();
-- Pure policy: explicit time allows deterministic boundary tests. No caller can
-- supply a clock to product authorization, which always uses clock_timestamp().
create function entitlement_decision(p jsonb,t timestamptz) returns jsonb language plpgsql immutable set search_path=public,pg_temp as $$
declare state text:='READ_ONLY';reason text:='UNPAID';until_at timestamptz;paid timestamptz:=(p->>'paidThrough')::timestamptz;
 grace timestamptz:=(p->>'graceEndsAt')::timestamptz;trial timestamptz:=(p->>'trialEndsAt')::timestamptz;
 deadline timestamptz:=(p->>'legacyEndsAt')::timestamptz;outage timestamptz:=(p->>'outageEndsAt')::timestamptz;
 status text:=p->>'status';established boolean:=coalesce((p->>'established')::boolean,false);
begin
 if not established then state:='DRAFT';reason:='PAYMENT_PENDING';end if;
 if not coalesce((p->>'profileComplete')::boolean,false) then return jsonb_build_object('state','DRAFT','reason','PAYMENT_PENDING','effectiveUntil',null,'canRead',false,'canWrite',false);end if;
 if (p->>'source')='LEGACY_MIGRATION' and coalesce((p->>'legacyEligible')::boolean,false) and not coalesce((p->>'legacyConsumed')::boolean,false) then
  if deadline is null or t<deadline then state:='LEGACY';reason:='LEGACY';until_at:=deadline;else reason:='LEGACY';end if;
 elsif (p->>'source')='STRIPE' and coalesce((p->>'approved')::boolean,false) then
  if coalesce((p->>'quarantined')::boolean,false) then reason:='UNPAID';
  elsif status not in ('active','past_due','canceled','unpaid','paused','incomplete','incomplete_expired','trialing') or status is null then reason:='UNPAID';
  elsif status in ('unpaid','paused','incomplete','incomplete_expired') then reason:=case when status='paused' then 'PAUSED' else 'UNPAID' end;
  elsif status='trialing' then
   if coalesce((p->>'trialsEnabled')::boolean,false) and trial is not null and t<trial then state:='TRIAL';reason:='TRIAL';until_at:=trial;else reason:='UNPAID';end if;
  elsif paid is not null then
   if (p->>'cancelAt')::timestamptz is not null then paid:=least(paid,(p->>'cancelAt')::timestamptz);end if;
   if t<paid then state:='ACTIVE';reason:=case when status='canceled' or coalesce((p->>'scheduledCancellation')::boolean,false) then 'CANCELED' when status='past_due' then 'RENEWAL_FAILED' else 'PAID' end;until_at:=paid;
   elsif status='past_due' and grace is not null and t<grace and not coalesce((p->>'scheduledCancellation')::boolean,false) then state:='GRACE';reason:='RENEWAL_FAILED';until_at:=grace;
   elsif status='active' and coalesce((p->>'providerUnavailable')::boolean,false) and not coalesce((p->>'scheduledCancellation')::boolean,false) and (p->>'cancelAt') is null and grace is null and outage is not null and t<outage then state:='ACTIVE';reason:='PROVIDER_UNAVAILABLE';until_at:=outage;
   else reason:=case when status='canceled' or coalesce((p->>'scheduledCancellation')::boolean,false) then 'CANCELED' when status='past_due' then 'RENEWAL_FAILED' else 'UNPAID' end;end if;
  end if;
 end if;
 if established and (p->>'exceptionUntil')::timestamptz>t and state='READ_ONLY' then state:='GRACE';reason:='PROVIDER_UNAVAILABLE';until_at:=(p->>'exceptionUntil')::timestamptz;end if;
 return jsonb_build_object('state',state,'reason',reason,'effectiveUntil',until_at,'canRead',state<>'DRAFT','canWrite',state in ('ACTIVE','TRIAL','GRACE','LEGACY'));
end $$;
create function entitlement_billing_recognized(p_account uuid,p_subscription uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from billing_accounts a join billing_subscriptions s on s.account_id=a.id
 join billing_checkout_attempts t on t.account_id=a.id and t.family_id=a.family_id and t.subscription_id=s.provider_id
 where a.id=p_account and s.id=p_subscription and a.customer_id is not null and t.session_id is not null and t.parameters->>'price'=s.price_id)
$$;
create function entitlement_effective(p_family uuid) returns jsonb language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare f families;e family_entitlements;c entitlement_cohorts;policy entitlement_policies;a billing_accounts;s billing_subscriptions;r jsonb;deadline timestamptz;cutoff timestamptz;
begin
 select * into f from families where id=p_family;
 select * into e from family_entitlements where family_id=p_family;
 select * into c from entitlement_cohorts where family_id=p_family;
 select p.* into policy from entitlement_policies p join entitlement_policy_current pc on pc.version=p.version;
 if e.family_id is null or c.family_id is null or policy.version is null then raise exception 'ENTITLEMENT_UNAVAILABLE';end if;
 if e.account_id is not null then select * into a from billing_accounts where id=e.account_id;end if;
 if e.subscription_id is not null then select * into s from billing_subscriptions where id=e.subscription_id and account_id=a.id;end if;
 deadline:=case when c.enforced and (policy.enforcement_enabled or c.legacy_enforcement_started) then coalesce(c.legacy_deadline,policy.legacy_deadline) else null end;
 -- A failure episode retains the approved cutoff from when it began. Policy
 -- changes never roll the clock forward. Outage also stays tied to paid-through.
 cutoff:=case when s.outage_blocked_through is not null and e.paid_through<=s.outage_blocked_through then null else e.outage_tolerance_ends_at end;
 r:=entitlement_decision(jsonb_build_object('profileComplete',f.profile_completed_at is not null,'established',f.lifecycle='ESTABLISHED',
 'source',e.source,'legacyEligible',f.creation_source='LEGACY' and f.legacy_access_eligible,'legacyConsumed',c.legacy_conversion_consumed,
 'legacyEndsAt',deadline,'approved',policy.approved and a.mode=policy.stripe_mode and a.merchant=policy.merchant and s.price_id=policy.price_id and entitlement_billing_recognized(a.id,s.id),
 'status',s.status,'paidThrough',e.paid_through,'trialEndsAt',e.trial_ends_at,'graceEndsAt',e.grace_ends_at,'outageEndsAt',cutoff,
 'trialsEnabled',policy.trials_enabled,'quarantined',a.quarantined and coalesce(a.alert,'')<>'PROVIDER_UNAVAILABLE',
 'providerUnavailable',a.alert='PROVIDER_UNAVAILABLE','scheduledCancellation',s.cancel_at_period_end,'cancelAt',s.cancel_at,
 'exceptionUntil',c.exception_until),clock_timestamp());
 return r||jsonb_build_object('version',e.version*100+case when r->>'state'='DRAFT' then 0 when r->>'state'='READ_ONLY' then 90 when r->>'reason'='PROVIDER_UNAVAILABLE' then 50 when r->>'state'='GRACE' then 20 when r->>'state'='LEGACY' then 30 else 10 end,
 'policyVersion',policy.version,'legacyEndsAt',deadline,'graceEndsAt',e.grace_ends_at,'paidThrough',e.paid_through,'trialEndsAt',e.trial_ends_at);
end $$;
create function entitlement_assert_write(p_family uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not (entitlement_effective(p_family)->>'canWrite')::boolean then raise exception 'SUBSCRIPTION_REQUIRED';end if;
end $$;
create or replace function tenant_product_access(p_family uuid) returns boolean language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin return (entitlement_effective(p_family)->>'canRead')::boolean;end $$;
create function membership_actor(p_auth uuid,p_family uuid,p_manage boolean default true) returns family_memberships language plpgsql security definer set search_path=public,pg_temp as $$
declare m family_memberships;
begin
 perform 1 from families where id=p_family for update;if not found then raise exception 'NOT_FOUND';end if;
 select fm.* into m from family_memberships fm join app_users u on u.id=fm.app_user_id where u.auth_user_id=p_auth and fm.family_id=p_family for update of fm;
 if m.id is null then raise exception 'FORBIDDEN';end if;
 if m.status<>'ACTIVE' or (m.member_id is not null and not exists(select 1 from family_members where id=m.member_id and active)) then raise exception 'ACCESS_REVOKED';end if;
 if p_manage and m.role not in ('OWNER','MANAGER') then raise exception 'FORBIDDEN';end if;
 perform set_config('app.actor',m.app_user_id::text,true);return m;
end $$;
create or replace function access_actor(p_auth uuid,p_family uuid,p_manage boolean default true) returns family_memberships language plpgsql security definer set search_path=public,pg_temp as $$
declare m family_memberships;
begin
 m:=membership_actor(p_auth,p_family,p_manage);
 perform entitlement_assert_write(p_family);return m;
end $$;
-- Safe DTO is independently membership checked; queues a lazy projection refresh.
create function entitlement_access(p_auth uuid,p_family uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare m family_memberships;r jsonb;
begin
 m:=membership_actor(p_auth,p_family,false);r:=entitlement_effective(p_family);
 insert into entitlement_jobs(family_id,due_at) values(p_family,now()) on conflict(family_id) do update set due_at=least(entitlement_jobs.due_at,excluded.due_at);
 return jsonb_build_object('state',r->>'state','reason',case r->>'reason' when 'PAID' then 'PAID' when 'TRIAL' then 'TRIAL' when 'LEGACY' then 'LEGACY' when 'PAYMENT_PENDING' then 'PAYMENT_PENDING' when 'PROVIDER_UNAVAILABLE' then 'TEMPORARY' when 'RENEWAL_FAILED' then 'PAYMENT_ISSUE' else 'EXPIRED' end,
 'effectiveUntil',r->'effectiveUntil','version',r->'version','canManageBilling',m.role='OWNER','canRead',(r->>'canRead')::boolean,'canWrite',(r->>'canWrite')::boolean,
 'ownerDeadlines',case when m.role='OWNER' then r- 'canWrite'- 'canRead' else null end);
end $$;
create function security_revoke_access(p_auth uuid,p_family uuid,p_member uuid,p_version integer,p_correlation text default null) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare actor family_memberships;m family_memberships;old_status text;
begin
 actor:=membership_actor(p_auth,p_family);
 perform 1 from family_members where id=p_member and family_id=p_family for update;if not found then raise exception 'NOT_FOUND';end if;
 select * into m from family_memberships where member_id=p_member and family_id=p_family for update;
 if m.id is null then raise exception 'NOT_FOUND';end if;
 if m.role='OWNER' then raise exception 'FORBIDDEN';end if;
 if m.access_version<>p_version then raise exception 'ACCESS_VERSION_CONFLICT';end if;
 update membership_email_changes set canceled_at=clock_timestamp() where membership_id=m.id and canceled_at is null and completed_at is null;
 old_status:=m.status;
 update family_memberships set status='REVOKED',revoked_at=clock_timestamp(),access_version=access_version+1,updated_by_app_user_id=actor.app_user_id,updated_at=clock_timestamp() where id=m.id returning * into m;
 perform audit_access(actor.app_user_id,m.id,'SECURITY_REVOKE',m.role,old_status,p_correlation);return to_jsonb(m);
end $$;
-- Remember observed terminal/cancellation restrictions across provider refreshes;
-- an active status without newer settled coverage cannot resurrect outage grace.
alter table billing_subscriptions add column outage_blocked_through timestamptz;
update billing_subscriptions set outage_blocked_through=paid_through where status in ('unpaid','paused','canceled') or cancel_at_period_end or cancel_at is not null;
create function entitlement_billing_restriction() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if new.status in ('unpaid','paused','canceled') or new.cancel_at_period_end or new.cancel_at is not null then
  new.outage_blocked_through:=greatest(new.outage_blocked_through,new.paid_through,case when tg_op='UPDATE' then old.paid_through end);
 elsif tg_op='UPDATE' then new.outage_blocked_through:=old.outage_blocked_through;end if;
 return new;
end $$;
create trigger entitlement_terminal_billing before insert or update on billing_subscriptions for each row execute function entitlement_billing_restriction();
-- Separate the provider worker fence from its latest committed snapshot.
alter table billing_accounts add column applied_version bigint not null default 0;
update billing_accounts a set applied_version=coalesce((select max(snapshot_version) from billing_change_outbox where account_id=a.id),0);
create function entitlement_enqueue() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into entitlement_jobs(family_id,due_at) values(new.family_id,clock_timestamp()) on conflict(family_id) do update set due_at=least(entitlement_jobs.due_at,excluded.due_at);return new;
end $$;
create trigger billing_entitlement_queue after insert on billing_change_outbox for each row execute function entitlement_enqueue();
create function entitlement_configure(p jsonb) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare existing entitlement_policies;next_policy entitlement_policies;
begin
 if p->>'version' is null or p->>'approval' is null or (p->>'graceDays') is null or (p->>'outageHours') is null or p->>'exceptionPolicy'<>'RESTRICT' then raise exception 'POLICY_CONFIGURATION_REQUIRED';end if;
 -- Operational policy publication serializes with every in-flight product write.
 perform 1 from families order by id for update;
 perform 1 from entitlement_policy_current for update;
 select * into existing from entitlement_policies where version=p->>'version';
 if existing.version is not null then
 if existing.grace_days<>(p->>'graceDays')::integer or existing.outage_hours<>(p->>'outageHours')::integer or existing.trials_enabled<>(p->>'trialsEnabled')::boolean or existing.enforcement_enabled<>(p->>'enforcementEnabled')::boolean or existing.legacy_deadline is distinct from (p->>'legacyDeadline')::timestamptz or existing.stripe_mode<>p->>'mode' or existing.merchant<>p->>'merchant' or existing.price_id<>p->>'priceId' or existing.approval_reference<>p->>'approval' or existing.member_limit is distinct from (p->>'memberLimit')::integer then raise exception 'POLICY_VERSION_CONFLICT';end if;
 else
 insert into entitlement_policies(version,approved,enforcement_enabled,grace_days,outage_hours,trials_enabled,legacy_deadline,stripe_mode,merchant,price_id,exception_policy,member_limit,approval_reference)
 values(p->>'version',true,(p->>'enforcementEnabled')::boolean,(p->>'graceDays')::integer,(p->>'outageHours')::integer,(p->>'trialsEnabled')::boolean,(p->>'legacyDeadline')::timestamptz,p->>'mode',p->>'merchant',p->>'priceId',p->>'exceptionPolicy',(p->>'memberLimit')::integer,p->>'approval');
 end if;
 if (select version from entitlement_policy_current)<>p->>'version' then
 update entitlement_policy_current set version=p->>'version';
 if (p->>'enforcementEnabled')::boolean then update entitlement_cohorts set legacy_enforcement_started=true,legacy_deadline=coalesce(legacy_deadline,(p->>'legacyDeadline')::timestamptz) where enforced;end if;
 insert into entitlement_events(family_id,prior_state,new_state,operation,reason,policy_version) select family_id,to_jsonb(e),to_jsonb(e),'POLICY_PUBLISHED','POLICY_CHANGED',p->>'version' from family_entitlements e;
 insert into entitlement_jobs(family_id,due_at) select id,clock_timestamp() from families on conflict(family_id) do update set due_at=excluded.due_at;
 end if;
end $$;
create function entitlement_claim() returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j entitlement_jobs;
begin
 select * into j from entitlement_jobs where due_at<=clock_timestamp() and (lease_until is null or lease_until<clock_timestamp()) order by due_at,family_id for update skip locked limit 1;
 if not found then return null;end if;
 update entitlement_jobs set lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1,updated_at=clock_timestamp() where family_id=j.family_id returning * into j;
 return to_jsonb(j);
end $$;
create function entitlement_project(p_family uuid,p_token uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare f families;e family_entitlements;prior jsonb;c entitlement_cohorts;policy entitlement_policies;a billing_accounts;s billing_subscriptions;
 o billing_change_outbox;r jsonb;source_value text;paid timestamptz;trial timestamptz;failure timestamptz;grace timestamptz;outage timestamptz;deadline timestamptz;stamp timestamptz;changed boolean;next_due timestamptz;
begin
 select * into f from families where id=p_family for update;
 perform 1 from entitlement_jobs where family_id=p_family and lease_token=p_token and lease_until>clock_timestamp() for update;
 if not found then raise exception 'ENTITLEMENT_FENCE_LOST';end if;
 stamp:=clock_timestamp();
 select * into e from family_entitlements where family_id=p_family for update;
 select * into c from entitlement_cohorts where family_id=p_family for update;
 select p.* into policy from entitlement_policies p join entitlement_policy_current pc on pc.version=p.version;
 if e.family_id is null or c.family_id is null or policy.version is null then raise exception 'ENTITLEMENT_UNAVAILABLE';end if;
 prior:=to_jsonb(e);
 select * into a from billing_accounts where family_id=p_family and mode=policy.stripe_mode and merchant=policy.merchant for update;
 if a.id is not null then
  select * into o from billing_change_outbox where account_id=a.id and snapshot_version=a.applied_version;
  select * into s from billing_subscriptions where account_id=a.id order by case when status not in ('canceled','incomplete_expired') then 0 else 1 end,paid_through desc nulls last,created_at desc,id limit 1;
 end if;
 source_value:=e.source;paid:=e.paid_through;trial:=e.trial_ends_at;failure:=e.first_renewal_failure_at;grace:=e.grace_ends_at;outage:=e.outage_tolerance_ends_at;
 if s.id is not null and policy.approved and entitlement_billing_recognized(a.id,s.id) and o.id is not null and (not a.quarantined or a.alert='PROVIDER_UNAVAILABLE') and (e.source<>'LEGACY_MIGRATION' or c.legacy_conversion_consumed or s.paid_through is not null or (policy.trials_enabled and s.status='trialing')) then
  source_value:='STRIPE';
  paid:=s.paid_through;trial:=case when policy.trials_enabled and s.status='trialing' then s.trial_end end;
  if e.subscription_id is distinct from s.id or paid is distinct from e.paid_through then
   outage:=case when paid is not null then paid+make_interval(hours=>policy.outage_hours) end;
  end if;
  if s.status='active' and s.invoice_status='paid' and paid is not null and (failure is null or paid>e.paid_through or paid>stamp) then failure:=null;grace:=null;
  elsif s.status='past_due' and e.source='STRIPE' and e.paid_through is not null and failure is null then
   select min(provider_created_at) into failure from billing_events where mode=a.mode and merchant=a.merchant and customer_id=a.customer_id and object_id=s.invoice_id and type='invoice.payment_failed';
   failure:=coalesce(failure,s.verified_at);
   grace:=greatest(e.paid_through,failure)+make_interval(days=>policy.grace_days);
  end if;
 end if;
 if s.status in ('unpaid','paused','canceled') or s.cancel_at_period_end or s.cancel_at is not null or (grace is not null and grace<=stamp) or (s.outage_blocked_through is not null and paid<=s.outage_blocked_through) then outage:=null;end if;
 deadline:=case when c.enforced and (policy.enforcement_enabled or c.legacy_enforcement_started) then coalesce(c.legacy_deadline,policy.legacy_deadline) else null end;
 r:=entitlement_decision(jsonb_build_object('profileComplete',f.profile_completed_at is not null,'established',f.lifecycle='ESTABLISHED',
 'source',source_value,'legacyEligible',f.creation_source='LEGACY' and f.legacy_access_eligible,'legacyConsumed',c.legacy_conversion_consumed,
 'legacyEndsAt',deadline,'approved',policy.approved and a.mode=policy.stripe_mode and a.merchant=policy.merchant and s.price_id=policy.price_id and entitlement_billing_recognized(a.id,s.id),
 'status',s.status,'paidThrough',paid,'trialEndsAt',trial,'graceEndsAt',grace,'outageEndsAt',outage,'trialsEnabled',policy.trials_enabled,
 'quarantined',a.quarantined and coalesce(a.alert,'')<>'PROVIDER_UNAVAILABLE','providerUnavailable',a.alert='PROVIDER_UNAVAILABLE',
 'scheduledCancellation',s.cancel_at_period_end,'cancelAt',s.cancel_at,'exceptionUntil',c.exception_until),stamp);
 if (r->>'canWrite')::boolean and r->>'state' in ('ACTIVE','TRIAL') and source_value='STRIPE' and o.id is not null then
  update families set lifecycle='ESTABLISHED',established_at=coalesce(established_at,stamp) where id=p_family;
  update entitlement_cohorts set legacy_conversion_consumed=true where family_id=p_family;
  insert into billing_activation_receipts(account_id,snapshot_version,established_at) values(a.id,a.applied_version,coalesce(f.established_at,stamp)) on conflict(account_id) do update set snapshot_version=excluded.snapshot_version;
 end if;
 changed:=e.state<>r->>'state' or e.reason<>r->>'reason' or e.source<>source_value or e.policy_version<>policy.version or e.billing_snapshot_version is distinct from (case when source_value='STRIPE' then o.snapshot_version else e.billing_snapshot_version end) or e.paid_through is distinct from paid or e.grace_ends_at is distinct from grace or e.legacy_ends_at is distinct from deadline or e.trial_ends_at is distinct from trial or e.outage_tolerance_ends_at is distinct from outage;
 if changed then
 update family_entitlements set state=r->>'state',reason=r->>'reason',source=source_value,account_id=case when source_value='STRIPE' then a.id else account_id end,
 subscription_id=case when source_value='STRIPE' then s.id else subscription_id end,billing_snapshot_version=case when source_value='STRIPE' then o.snapshot_version else billing_snapshot_version end,
 paid_through=paid,trial_ends_at=trial,first_renewal_failure_at=failure,grace_ends_at=grace,outage_tolerance_ends_at=outage,legacy_ends_at=deadline,
 verified_at=case when source_value='STRIPE' then a.verified_at else verified_at end,policy_version=policy.version,version=version+1,updated_at=stamp where family_id=p_family returning * into e;
 insert into entitlement_events(family_id,prior_state,new_state,operation,outbox_id,reason,policy_version) values(p_family,prior,to_jsonb(e),'PROJECTION',o.id,e.reason,policy.version);
 end if;
 if o.id is not null then update billing_change_outbox set consumed_at=coalesce(consumed_at,stamp) where account_id=a.id and snapshot_version<=a.applied_version;end if;
 select min(v) into next_due from unnest(array[(r->>'effectiveUntil')::timestamptz,grace,outage,deadline,c.exception_until]) v where v>stamp;
 update entitlement_jobs set lease_token=null,lease_until=null,attempts=0,safe_error=case when s.status is not null and s.status not in ('active','past_due','canceled','unpaid','paused','incomplete','incomplete_expired','trialing') then 'UNKNOWN_PROVIDER_STATUS' when s.id is not null and s.price_id<>policy.price_id then 'PRICE_REQUIRES_REVIEW' end,due_at=least(coalesce(next_due,stamp+interval '1 minute'),stamp+interval '1 minute'),updated_at=stamp where family_id=p_family;
end $$;
create function entitlement_retry(p_family uuid,p_token uuid) returns void language sql security definer set search_path=public,pg_temp as $$
 update entitlement_jobs set lease_token=null,lease_until=null,safe_error=case when attempts>=10 then 'PROJECTION_REQUIRES_REVIEW' else 'PROJECTION_RETRY' end,
 due_at=clock_timestamp()+make_interval(secs=>least(3600,power(2,least(attempts,12))::integer)),updated_at=clock_timestamp() where family_id=p_family and lease_token=p_token
$$;
create function entitlement_rollout(p_family uuid,p_enforced boolean,p_reason text,p_exception_until timestamptz default null) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare e family_entitlements;policy entitlement_policies;
begin
 perform 1 from families where id=p_family for update;
 select * into e from family_entitlements where family_id=p_family for update;
 select p.* into policy from entitlement_policies p join entitlement_policy_current pc on pc.version=p.version;
 if e.family_id is null then raise exception 'NOT_FOUND';end if;
 if nullif(btrim(p_reason),'') is null or length(p_reason)>120 then raise exception 'VALIDATION';end if;
 if p_enforced and (not policy.approved or (policy.legacy_deadline is null and exists(select 1 from families where id=p_family and creation_source='LEGACY') and not exists(select 1 from entitlement_cohorts where family_id=p_family and legacy_enforcement_started))) then raise exception 'POLICY_CONFIGURATION_REQUIRED';end if;
 if not p_enforced and exists(select 1 from entitlement_cohorts where family_id=p_family and enforced) then raise exception 'VALIDATION';end if;
 if p_exception_until is not null and (p_exception_until<=clock_timestamp() or p_exception_until>clock_timestamp()+interval '24 hours' or not exists(select 1 from families where id=p_family and lifecycle='ESTABLISHED')) then raise exception 'VALIDATION';end if;
 -- Disabling a cohort does not bypass billing. Only the explicitly bounded
 -- established-family exception can temporarily restore writes.
 update entitlement_cohorts set enforced=p_enforced,legacy_enforcement_started=legacy_enforcement_started or (p_enforced and policy.enforcement_enabled),legacy_deadline=coalesce(legacy_deadline,case when p_enforced and policy.enforcement_enabled then policy.legacy_deadline end),exception_until=p_exception_until,exception_reason=p_reason,updated_at=clock_timestamp() where family_id=p_family;
 update family_entitlements set version=version+1 where family_id=p_family;
 insert into entitlement_events(family_id,prior_state,new_state,operation,reason,policy_version) select p_family,to_jsonb(e),to_jsonb(n),'ROLLOUT_EXCEPTION',p_reason,policy.version from family_entitlements n where family_id=p_family;
 insert into entitlement_jobs(family_id,due_at) values(p_family,clock_timestamp()) on conflict(family_id) do update set due_at=excluded.due_at;
end $$;
create function entitlement_heartbeat(p_name text) returns void language sql security definer set search_path=public,pg_temp as $$
 insert into deployment_worker_heartbeats(name) values(p_name) on conflict(name) do update set seen_at=clock_timestamp()
$$;

create or replace function billing_apply_snapshot(p_id uuid,p_token uuid,p_version bigint,p_subscriptions jsonb,p_alert text default null) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare a billing_accounts;s jsonb;
begin
 select * into a from billing_accounts where id=p_id;
 perform 1 from families where id=a.family_id for update;
 select * into a from billing_accounts where id=p_id for update;
 if a.lease_token is distinct from p_token or a.version<>p_version or a.lease_until<now() then raise exception 'BILLING_FENCE_LOST';end if;
 for s in select * from jsonb_array_elements(p_subscriptions) loop
 if exists(select 1 from billing_subscriptions where mode=a.mode and merchant=a.merchant and provider_id=s->>'id' and account_id<>a.id) then raise exception 'BILLING_UNAVAILABLE';end if;
 insert into billing_subscriptions(account_id,provider_id,mode,merchant,price_id,status,cancel_at_period_end,cancel_at,period_start,period_end,trial_end,invoice_id,invoice_status,paid_through,verified_at,snapshot_version)
 values(a.id,s->>'id',a.mode,a.merchant,s->>'price',s->>'status',(s->>'cancelAtPeriodEnd')::boolean,(s->>'cancelAt')::timestamptz,(s->>'periodStart')::timestamptz,(s->>'periodEnd')::timestamptz,(s->>'trialEnd')::timestamptz,s->>'invoiceId',s->>'invoiceStatus',(s->>'paidThrough')::timestamptz,now(),p_version)
 on conflict(mode,merchant,provider_id) do update set status=excluded.status,cancel_at_period_end=excluded.cancel_at_period_end,cancel_at=excluded.cancel_at,period_start=excluded.period_start,period_end=excluded.period_end,trial_end=excluded.trial_end,invoice_id=excluded.invoice_id,invoice_status=excluded.invoice_status,
 paid_through=case when billing_subscriptions.paid_through is null then excluded.paid_through when excluded.paid_through is null then billing_subscriptions.paid_through else greatest(billing_subscriptions.paid_through,excluded.paid_through) end,
 verified_at=excluded.verified_at,snapshot_version=excluded.snapshot_version;
 end loop;
 -- Missing previously recognized nonterminal subscriptions are ambiguous, not canceled.
 if exists(select 1 from billing_subscriptions where account_id=a.id and status not in ('canceled','incomplete_expired') and snapshot_version<>p_version) then p_alert:='MISSING_SUBSCRIPTION';end if;
 if (select count(*) from billing_subscriptions where account_id=a.id and status not in ('canceled','incomplete_expired'))>1 then p_alert:='MULTIPLE_SUBSCRIPTIONS';end if;
 -- Completed sessions remain unresolved until their recognized subscription terminates.
 update billing_checkout_attempts t set state='CLOSED',updated_at=now() where t.account_id=a.id and t.state='COMPLETED' and exists(select 1 from billing_subscriptions s where s.account_id=a.id and s.provider_id=t.subscription_id and s.status in ('canceled','incomplete_expired'));
 update billing_accounts set applied_version=p_version,verified_at=now(),failures=0,quarantined=quarantined or p_alert is not null,alert=coalesce(p_alert,alert),lease_token=null,lease_until=null,
 reconcile_at=now()+case when exists(select 1 from billing_checkout_attempts where account_id=a.id and state in ('CREATING','OPEN','UNKNOWN','COMPLETED')) then interval '1 minute' else interval '1 hour' end,updated_at=now() where id=a.id;
 if p_alert is null and not a.quarantined then insert into billing_change_outbox(family_id,account_id,snapshot_version) values(a.family_id,a.id,p_version) on conflict do nothing;end if;
 insert into billing_audit_events(family_id,operation,result) values(a.family_id,'RECONCILE',coalesce(p_alert,'VERIFIED'));
end $$;

create function entitlement_activation_confirmed(p_account uuid) returns boolean language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare a billing_accounts;
begin
 select * into a from billing_accounts where id=p_account;
 if not exists(select 1 from family_entitlements where family_id=a.family_id) then return false;end if;
 return exists(select 1 from billing_activation_receipts r join families f on f.id=a.family_id where r.account_id=a.id and r.snapshot_version=a.applied_version and f.lifecycle='ESTABLISHED') and (entitlement_effective(a.family_id)->>'canWrite')::boolean;
exception when others then return false;
end $$;

create or replace function billing_owner_state(p_auth uuid,p_family uuid,p_mode text,p_attempt uuid default null) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a billing_accounts;t billing_checkout_attempts;
begin
 perform billing_owner(p_auth,p_family);
 select * into a from billing_accounts where family_id=p_family and mode=p_mode;
 if p_attempt is not null then
 select * into t from billing_checkout_attempts where id=p_attempt and family_id=p_family and account_id=a.id;
 if not found then raise exception 'NOT_FOUND';end if;
 else select * into t from billing_checkout_attempts where account_id=a.id order by created_at desc limit 1;end if;
 -- Owner-triggered refresh is bounded across all HTTP instances.
 update billing_accounts set reconcile_at=least(reconcile_at,now()),refresh_requested_at=now() where id=a.id and (refresh_requested_at is null or refresh_requested_at<now()-interval '30 seconds');
 return jsonb_build_object('account',case when a.id is null then null else to_jsonb(a) end,'attempt',case when t.id is null then null else to_jsonb(t) end,
 'subscriptions',coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at desc) from billing_subscriptions s where s.account_id=a.id),'[]'::jsonb),
 'activation',entitlement_activation_confirmed(a.id));
end $$;

create or replace function confirm_membership_email_change(p_auth uuid,p_email text,p_hash text,p_correlation text) returns void
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
 perform entitlement_assert_write(m.family_id);
 update family_memberships set login_email=btrim(p_email),normalized_email=c.normalized_email,status='ACTIVE',revoked_at=null,access_version=access_version+1,updated_at=now() where id=m.id;
 update membership_email_changes set completed_at=now() where id=c.id;
 perform audit_access(actor,m.id,'EMAIL_CHANGE_CONFIRMED',m.role,m.status,p_correlation);
exception when unique_violation then raise exception 'ACCESS_CONFLICT';
end $$;


-- Guard every old ledger/settings RPC as well as the unified resource writers.
-- The underlying implementations are owner-private, including to service_role.
create function entitlement_actor_for_resource(p_family uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare subject uuid;
begin
 select auth_user_id into subject from app_users where id=nullif(current_setting('app.actor',true),'')::uuid;
 if subject is null then raise exception 'FORBIDDEN';end if;
 perform access_actor(subject,p_family);
end $$;
alter function complete_task(uuid,uuid,uuid) rename to private_complete_task;
alter function reopen_task(uuid) rename to private_reopen_task;
alter function redeem_award(uuid,uuid,uuid) rename to private_redeem_award;
create function complete_task(
  p_task_id uuid,
  p_member_id uuid,
  p_responsible_user_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform entitlement_actor_for_resource((select family_id from tasks where id=p_task_id));
 return private_complete_task(p_task_id,p_member_id,p_responsible_user_id);
end $$;
create function reopen_task(p_task_id uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform entitlement_actor_for_resource((select family_id from tasks where id=p_task_id));
 return private_reopen_task(p_task_id);
end $$;
create function redeem_award(
  p_award_id uuid,
  p_member_id uuid,
  p_family_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform entitlement_actor_for_resource(p_family_id);
 return private_redeem_award(p_award_id,p_member_id,p_family_id);
end $$;
alter function update_family(uuid,uuid,boolean,text,boolean,text,boolean,text,boolean,text) rename to private_update_family;
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
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform entitlement_actor_for_resource(p_family_id);
 perform private_update_family(p_family_id,p_responsible_user_id,p_set_name,p_name,p_set_avatar_url,p_avatar_url,p_set_relationship,p_relationship,p_set_responsible_name,p_responsible_name);
end $$;

alter function authorized_resource_write(uuid,uuid,text,text,uuid,jsonb,text) rename to private_resource_write;
create function authorized_resource_write(p_auth uuid,p_family uuid,p_table text,p_operation text,p_id uuid,p_data jsonb,p_correlation text default null) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare actor family_memberships;cap integer;needed integer;source_value text;
begin
 actor:=access_actor(p_auth,p_family);
 select e.source,p.member_limit into source_value,cap from family_entitlements e join entitlement_policy_current pc on true join entitlement_policies p on p.version=pc.version where e.family_id=p_family;
 if source_value='STRIPE' and cap is not null and p_table='family_members' then
  if p_operation='insert' then
   select count(*) into needed from jsonb_array_elements(case when jsonb_typeof(p_data)='array' then p_data else jsonb_build_array(p_data) end) v where coalesce((v->>'active')::boolean,true);
  elsif p_operation='update' and p_data->>'active'='true' and exists(select 1 from family_members where id=p_id and family_id=p_family and not active) then needed:=1;
  else needed:=0;end if;
  if needed>0 and (select count(*) from family_members where family_id=p_family and active)+needed>cap then raise exception 'MEMBER_LIMIT_REACHED';end if;
 end if;
 return private_resource_write(p_auth,p_family,p_table,p_operation,p_id,p_data,p_correlation);
end $$;
alter function tenant_onboarding(uuid,jsonb) rename to private_tenant_onboarding;
create function tenant_onboarding(p_auth uuid,p_input jsonb default null) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare m family_memberships;f families;
begin
 select fm.* into m from family_memberships fm join app_users u on u.id=fm.app_user_id where u.auth_user_id=p_auth;
 if m.id is null or m.role<>'OWNER' then raise exception 'FORBIDDEN';end if;
 perform membership_actor(p_auth,m.family_id);
 select * into f from families where id=m.family_id;
 if p_input is not null and f.lifecycle='ESTABLISHED' and f.profile_completed_at is not null then perform entitlement_assert_write(f.id);end if;
 return private_tenant_onboarding(p_auth,p_input);
end $$;
create or replace function billing_reserve(p_auth uuid,p_family uuid,p_key uuid,p_hash text,p_mode text,p_merchant text,p_parameters jsonb,p_correlation text default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a billing_accounts;t billing_checkout_attempts;actor uuid;
begin
 actor:=billing_owner(p_auth,p_family);
 if not exists(select 1 from family_entitlements where family_id=p_family) then raise exception 'ENTITLEMENT_UNAVAILABLE';end if;
 if not exists(select 1 from entitlement_policies p join entitlement_policy_current pc on pc.version=p.version where p.approved and p.stripe_mode=p_mode and p.merchant=p_merchant and p.price_id=p_parameters->>'price') then raise exception 'POLICY_CONFIGURATION_REQUIRED';end if;
 if not exists(select 1 from families where id=p_family and profile_completed_at is not null) then raise exception 'PLAN_UNAVAILABLE';end if;
 select * into t from billing_checkout_attempts where family_id=p_family and request_key=p_key;
 if found then
 if t.request_hash<>p_hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;
 if not exists(select 1 from billing_accounts where id=t.account_id and mode=p_mode and merchant=p_merchant) then raise exception 'BILLING_UNAVAILABLE';end if;
 return jsonb_build_object('attempt',to_jsonb(t),'created',false);end if;
 insert into billing_accounts(family_id,mode,merchant) values(p_family,p_mode,p_merchant) on conflict(family_id,mode) do nothing;
 select * into a from billing_accounts where family_id=p_family and mode=p_mode for update;
 if a.merchant<>p_merchant or a.quarantined then raise exception 'BILLING_UNAVAILABLE';end if;
 if exists(select 1 from billing_subscriptions where account_id=a.id and status not in ('canceled','incomplete_expired')) then raise exception 'SUBSCRIPTION_EXISTS';end if;
 -- A fresh full provider reconciliation is required before resubscription.
 if a.customer_id is not null and (a.verified_at is null or a.verified_at<now()-interval '60 seconds') then
 update billing_accounts set reconcile_at=now() where id=a.id;
 return jsonb_build_object('processing',true);end if;
 select * into t from billing_checkout_attempts where family_id=p_family and state in ('CREATING','OPEN','UNKNOWN','COMPLETED');
 if found then return jsonb_build_object('attempt',to_jsonb(t),'created',false);end if;
 insert into billing_checkout_attempts(account_id,family_id,owner_app_user_id,request_key,request_hash,parameters)
 values(a.id,p_family,actor,p_key,p_hash,p_parameters) returning * into t;
 update billing_accounts set reconcile_at=now() where id=a.id;
 insert into billing_audit_events(family_id,actor_app_user_id,operation,result,correlation_id) values(p_family,actor,'CHECKOUT_RESERVED','PENDING',p_correlation);
 return jsonb_build_object('attempt',to_jsonb(t),'created',true);
end $$;

-- Onboarding completion of a restricted established tenant opens its read-only
-- dashboard; profile completion never substitutes for entitlement activation.
create or replace function tenant_onboarding_result(p_family uuid) returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('family',jsonb_build_object('id',f.id,'name',f.name,'avatar_url',f.avatar_url,'responsible_name',r.name,'relationship',r.relationship),
 'lifecycle',f.lifecycle,'profileCompleted',f.profile_completed_at is not null,'nextAction',case when f.profile_completed_at is null then 'COMPLETE_PROFILE' when tenant_product_access(f.id) then 'OPEN_DASHBOARD' else 'SUBSCRIBE' end)
 from families f join responsible_users r on r.id=f.responsible_user_id where f.id=p_family
$$;
do $$ declare n text;r record;begin
 foreach n in array array['entitlement_policies','entitlement_policy_current','entitlement_cohorts','family_entitlements','entitlement_events','entitlement_jobs','deployment_worker_heartbeats'] loop
 execute format('alter table %I enable row level security',n);execute format('revoke all on %I from public,anon,authenticated',n);execute format('grant all on %I to service_role',n);
 end loop;
 for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'entitlement_%' or p.proname in ('membership_actor','security_revoke_access','authorized_resource_write','complete_task','reopen_task','redeem_award','update_family','tenant_onboarding')) loop
 execute format('revoke all on function %s from public,anon,authenticated',r.sig);execute format('grant execute on function %s to service_role',r.sig);
 end loop;
 for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('private_resource_write','private_complete_task','private_reopen_task','private_redeem_award','private_update_family','private_tenant_onboarding') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',r.sig);
 end loop;
end $$;
commit;
