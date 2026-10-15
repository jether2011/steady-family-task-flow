-- Durable billing operations. No provider requests, charges or entitlement grants.
begin;
create table billing_accounts(
 id uuid primary key default gen_random_uuid(), family_id uuid not null references families(id) on delete restrict,
 mode text not null check(mode in ('TEST','LIVE')), merchant text not null,
 customer_id text, creation_status text not null default 'PENDING' check(creation_status in ('PENDING','READY','UNKNOWN')),
 failures integer not null default 0, version bigint not null default 0, lease_token uuid, lease_until timestamptz,
 reconcile_at timestamptz not null default now(), verified_at timestamptz, quarantined boolean not null default false,
 alert text, refresh_requested_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(family_id,mode),unique(mode,merchant,customer_id), unique(id,mode,merchant),unique(id,family_id), unique(id,family_id,mode,merchant)
);
create table billing_subscriptions(
 id uuid primary key default gen_random_uuid(), account_id uuid not null references billing_accounts(id) on delete restrict,
 provider_id text not null, mode text not null, merchant text not null, price_id text not null,status text not null,
 cancel_at_period_end boolean not null, cancel_at timestamptz, period_start timestamptz,period_end timestamptz,
 trial_end timestamptz, invoice_id text,invoice_status text,paid_through timestamptz, verified_at timestamptz not null,
 snapshot_version bigint not null, created_at timestamptz not null default now(),unique(mode,merchant,provider_id),
 foreign key(account_id,mode,merchant) references billing_accounts(id,mode,merchant)
);
create table billing_checkout_attempts(
 id uuid primary key default gen_random_uuid(), account_id uuid not null references billing_accounts(id) on delete restrict,
 family_id uuid not null references families(id) on delete restrict,owner_app_user_id uuid not null references app_users(id),
 request_key uuid not null,request_hash text not null,parameters jsonb not null,
 state text not null default 'CREATING' check(state in ('CREATING','OPEN','COMPLETED','EXPIRED','FAILED','UNKNOWN','CLOSED')),
 session_id text unique,url text,expires_at timestamptz,subscription_id text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(family_id,request_key),foreign key(account_id,family_id) references billing_accounts(id,family_id)
);
create unique index billing_one_unresolved_checkout on billing_checkout_attempts(family_id) where state in ('CREATING','OPEN','UNKNOWN','COMPLETED');
create table billing_events(
 id uuid primary key default gen_random_uuid(), mode text not null,merchant text not null,provider_id text not null,
 type text not null,object_id text,customer_id text,provider_created_at timestamptz not null,
 state text not null check(state in ('PENDING','PROCESSING','APPLIED','FAILED','IGNORED')),
 attempts integer not null default 0,lease_token uuid,lease_until timestamptz,retry_at timestamptz not null default now(),
 safe_error text,received_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(mode,merchant,provider_id)
);
create index billing_inbox_due on billing_events(retry_at) where state in ('PENDING','PROCESSING');
create table billing_audit_events(
 id uuid primary key default gen_random_uuid(),family_id uuid references families(id),actor_app_user_id uuid references app_users(id),
 operation text not null,result text not null,provider_ref text,correlation_id text,created_at timestamptz not null default now()
);
create trigger billing_audit_immutable before update or delete on billing_audit_events for each row execute function prevent_access_audit_rewrite();
create table billing_change_outbox(
 id uuid primary key default gen_random_uuid(),family_id uuid not null references families(id),account_id uuid not null references billing_accounts(id),
 snapshot_version bigint not null, consumed_at timestamptz,created_at timestamptz not null default now(),unique(account_id,snapshot_version)
);
-- Spec 06 consumes this outbox and writes its exact applied version here in the
-- same entitlement transaction. Billing facts alone cannot confirm activation.
create table billing_activation_receipts(
 account_id uuid primary key references billing_accounts(id),snapshot_version bigint not null,established_at timestamptz not null
);
create function billing_owner(p_auth uuid,p_family uuid) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare actor uuid;
begin
 perform 1 from families where id=p_family for update;
 select m.app_user_id into actor from family_memberships m join app_users u on u.id=m.app_user_id
 where u.auth_user_id=p_auth and m.family_id=p_family and m.role='OWNER' and m.status='ACTIVE' for update of m;
 if actor is null then raise exception 'FORBIDDEN'; end if;return actor;
end $$;
create function billing_owner_state(p_auth uuid,p_family uuid,p_mode text,p_attempt uuid default null) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
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
 'activation',not coalesce(a.quarantined,false) and exists(select 1 from billing_activation_receipts r join families f on f.id=a.family_id where r.account_id=a.id and r.snapshot_version=a.version and f.lifecycle='ESTABLISHED'));
end $$;
create function billing_reserve(p_auth uuid,p_family uuid,p_key uuid,p_hash text,p_mode text,p_merchant text,p_parameters jsonb,p_correlation text default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a billing_accounts;t billing_checkout_attempts;actor uuid;
begin
 actor:=billing_owner(p_auth,p_family);
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
create function billing_claim_account(p_mode text,p_merchant text,p_id uuid default null) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a billing_accounts;
begin
 select * into a from billing_accounts where mode=p_mode and merchant=p_merchant and (p_id is null or id=p_id)
 and (p_id is not null or reconcile_at<=now()) and (lease_until is null or lease_until<now()) order by reconcile_at for update skip locked limit 1;
 if not found then return null;end if;
 update billing_accounts set lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',version=version+1 where id=a.id returning * into a;
 return to_jsonb(a);
end $$;
create function billing_finish_operation(p_id uuid,p_token uuid,p_version bigint,p_customer text default null,p_attempt uuid default null,p_session jsonb default null) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare a billing_accounts;
begin
 select * into a from billing_accounts where id=p_id;
 perform 1 from families where id=a.family_id for update;
 select * into a from billing_accounts where id=p_id for update;
 if a.lease_token is distinct from p_token or a.version<>p_version or a.lease_until<now() then raise exception 'BILLING_FENCE_LOST';end if;
 if p_customer is not null then
 if a.customer_id is not null and a.customer_id<>p_customer then raise exception 'BILLING_UNAVAILABLE';end if;
 update billing_accounts set customer_id=p_customer,creation_status='READY',updated_at=now() where id=a.id;
 end if;
 if p_attempt is not null then
 update billing_checkout_attempts set state=p_session->>'state',session_id=coalesce(p_session->>'id',session_id),url=coalesce(p_session->>'url',url),
 expires_at=coalesce((p_session->>'expiresAt')::timestamptz,expires_at),subscription_id=coalesce(p_session->>'subscription',subscription_id),updated_at=now()
 where id=p_attempt and account_id=a.id;
 if not found then raise exception 'NOT_FOUND';end if;
 end if;
end $$;
create function billing_apply_snapshot(p_id uuid,p_token uuid,p_version bigint,p_subscriptions jsonb,p_alert text default null) returns void
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
 update billing_accounts set verified_at=now(),failures=0,quarantined=quarantined or p_alert is not null,alert=coalesce(p_alert,alert),lease_token=null,lease_until=null,
 reconcile_at=now()+case when exists(select 1 from billing_checkout_attempts where account_id=a.id and state in ('CREATING','OPEN','UNKNOWN','COMPLETED')) then interval '1 minute' else interval '1 hour' end,updated_at=now() where id=a.id;
 if p_alert is null and not a.quarantined then insert into billing_change_outbox(family_id,account_id,snapshot_version) values(a.family_id,a.id,p_version) on conflict do nothing;end if;
 insert into billing_audit_events(family_id,operation,result) values(a.family_id,'RECONCILE',coalesce(p_alert,'VERIFIED'));
end $$;
create function billing_fail_account(p_id uuid,p_token uuid,p_error text,p_quarantine boolean default false,p_limit integer default 10) returns void language sql security definer set search_path=public,pg_temp as $$
 update billing_accounts set lease_token=null,lease_until=null,reconcile_at=now()+make_interval(secs=>least(3600,power(2,least(failures+1,12))::int+floor(random()*5)::int)),alert=p_error,failures=failures+1,quarantined=quarantined or p_quarantine or failures+1>=p_limit,creation_status=case when customer_id is null then 'UNKNOWN' else creation_status end where id=p_id and lease_token=p_token
$$;
create function billing_ingest(p_mode text,p_merchant text,p_event text,p_type text,p_object text,p_customer text,p_created timestamptz,p_supported boolean) returns void language sql security definer set search_path=public,pg_temp as $$
 insert into billing_events(mode,merchant,provider_id,type,object_id,customer_id,provider_created_at,state)
 values(p_mode,p_merchant,p_event,p_type,p_object,p_customer,p_created,case when p_supported then 'PENDING' else 'IGNORED' end) on conflict(mode,merchant,provider_id) do nothing
$$;
create function billing_claim_event(p_mode text,p_merchant text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare e billing_events;
begin
 select * into e from billing_events where mode=p_mode and merchant=p_merchant and state in ('PENDING','PROCESSING') and retry_at<=now() and (lease_until is null or lease_until<now()) order by received_at for update skip locked limit 1;
 if not found then return null;end if;
 update billing_events set state='PROCESSING',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '120 seconds',updated_at=now() where id=e.id returning * into e;
 return to_jsonb(e);
end $$;
create function billing_finish_event(p_id uuid,p_token uuid,p_state text,p_error text default null,p_delay integer default 0) returns void language sql security definer set search_path=public,pg_temp as $$
 update billing_events set state=p_state,safe_error=p_error,retry_at=now()+make_interval(secs=>p_delay),lease_token=null,lease_until=null,updated_at=now() where id=p_id and lease_token=p_token and lease_until>now()
$$;
-- Operator-only replay, executed via a privileged CLI, never an HTTP route.
create function billing_replay_event(p_id uuid) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update billing_events set state='PENDING',attempts=0,retry_at=now(),lease_token=null,lease_until=null where id=p_id and state in ('FAILED','APPLIED');
 if not found then raise exception 'NOT_FOUND';end if;
 insert into billing_audit_events(operation,result,provider_ref) values('OPERATOR_REPLAY','REQUESTED',p_id::text);
end $$;
create function billing_release_quarantine(p_id uuid,p_review text) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare fid uuid;
begin
 if nullif(btrim(p_review),'') is null or length(p_review)>120 then raise exception 'VALIDATION';end if;
 select family_id into fid from billing_accounts where id=p_id;
 perform 1 from families where id=fid for update;
 update billing_accounts set quarantined=false,alert=null,failures=0,lease_token=null,lease_until=null,version=version+1,reconcile_at=now() where id=p_id;
 if not found then raise exception 'NOT_FOUND';end if;
 insert into billing_audit_events(family_id,operation,result,provider_ref) values(fid,'OPERATOR_REVIEW_RELEASE',p_review,p_id::text);
end $$;
do $$ declare n text;r record;begin
 foreach n in array array['billing_accounts','billing_subscriptions','billing_checkout_attempts','billing_events','billing_audit_events','billing_change_outbox','billing_activation_receipts'] loop
 execute format('alter table %I enable row level security',n);execute format('revoke all on %I from public,anon,authenticated',n);execute format('grant all on %I to service_role',n);
 end loop;
 for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'billing_%' loop
 execute format('revoke all on function %s from public,anon,authenticated',r.sig);execute format('grant execute on function %s to service_role',r.sig);
 end loop;
end $$;
commit;
