-- Read models only. Apply once after 007. Every function call uses one snapshot.
begin;
create index points_member_history on points_transactions(family_id,member_id,created_at desc,id desc);
create index completions_member_history on task_completions(family_id,completed_by_member_id,completed_at desc,id desc);
create index points_family_history on points_transactions(family_id,created_at desc,id desc);
create function member_view_read(p_auth uuid,p_kind text,p_input jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare a family_memberships; target uuid; result jsonb; stamp timestamptz:=statement_timestamp(); lower_bound timestamptz; upper_bound timestamptz; page_limit integer; page_time timestamptz; page_id uuid;
begin
 select m.* into a from family_memberships m join app_users u on u.id=m.app_user_id
 where u.auth_user_id=p_auth and m.status='ACTIVE' and (m.member_id is null or exists(select 1 from family_members fm where fm.id=m.member_id and fm.family_id=m.family_id and fm.active));
 if a.id is null then raise exception 'ACCESS_REVOKED'; end if;
 target:=nullif(p_input->>'memberId','')::uuid;
 if a.role='MEMBER' then
  if target is not null and target is distinct from a.member_id then raise exception 'NOT_FOUND'; end if;
  target:=a.member_id;
 end if;
 if target is not null and not exists(select 1 from family_members where id=target and family_id=a.family_id) then raise exception 'NOT_FOUND'; end if;
 lower_bound:=case when length(p_input->>'from')=10 then ((p_input->>'from')::date::timestamp at time zone 'UTC') else nullif(p_input->>'from','')::timestamptz end;
 upper_bound:=coalesce(((nullif(p_input->>'to','')::date+interval '1 day') at time zone 'UTC'),stamp);
 upper_bound:=least(upper_bound,stamp);
 page_limit:=coalesce((p_input->>'limit')::int,50);
 if page_limit<1 or page_limit>101 then raise exception 'VALIDATION'; end if;
 page_time:=nullif(p_input->>'pageTime','')::timestamptz;page_id:=nullif(p_input->>'pageId','')::uuid;
 if p_kind='directory' then
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'avatar_url',avatar_url,'color',color,'member_type',member_type,'active',active) order by name,id),'[]') into result from family_members where family_id=a.family_id and active;
  return jsonb_build_object('members',result);
 elsif p_kind='profile' then
  if target is null then raise exception 'FORBIDDEN'; end if;
  select jsonb_build_object('member',jsonb_build_object('id',m.id,'name',m.name,'avatar_url',m.avatar_url,'color',m.color,'member_type',m.member_type,'active',m.active,'birth_year',m.birth_year),'balance',(select coalesce(sum(points),0) from points_transactions where family_id=a.family_id and member_id=target)) into result from family_members m where m.id=target and m.family_id=a.family_id;
  return result;
 elsif p_kind='summary' then
  select jsonb_build_object(
   'earned',coalesce(sum(points) filter(where transaction_type='TASK_COMPLETION' and points>0),0),
   'adjustments',coalesce(sum(points) filter(where transaction_type='MANUAL_ADJUSTMENT'),0),
   'reversed',abs(coalesce(sum(points) filter(where transaction_type='REVERSAL'),0)),
   'spent',abs(coalesce(sum(points) filter(where transaction_type='REDEMPTION'),0)),
   'net',coalesce(sum(points),0),
   'balance',(select coalesce(sum(points),0) from points_transactions where family_id=a.family_id and (target is null or member_id=target))) into result
  from points_transactions where family_id=a.family_id and (target is null or member_id=target) and (lower_bound is null or created_at>=lower_bound) and created_at<upper_bound;
  return result;
 elsif p_kind='points' then
  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc,t.id desc),'[]') into result from (
   select id,family_id,member_id,task_id,points,transaction_type,created_at from points_transactions where family_id=a.family_id and (target is null or member_id=target) and (lower_bound is null or created_at>=lower_bound) and created_at<upper_bound
   and (p_input->>'type' is null or transaction_type=p_input->>'type')
   and (page_time is null or (created_at,id)<(page_time,page_id)) order by created_at desc,id desc limit page_limit
  ) t;return jsonb_build_object('transactions',result);
 elsif p_kind='completions' then
  if target is null then raise exception 'FORBIDDEN'; end if;
  with page as (select id,task_id,family_id,completed_by_member_id,completed_at,(select coalesce(sum(p.points),0) from points_transactions p where p.family_id=a.family_id and p.member_id=target and p.task_id=task_completions.task_id and p.transaction_type='TASK_COMPLETION' and p.points>0 and p.created_at>=task_completions.completed_at) awarded_points,(select title from tasks where tasks.id=task_completions.task_id and tasks.family_id=a.family_id) task_title from task_completions where family_id=a.family_id and completed_by_member_id=target and completed_at<=stamp and (page_time is null or (completed_at,id)<(page_time,page_id)) order by completed_at desc,id desc limit page_limit)
  select jsonb_build_object('completions',coalesce((select jsonb_agg(to_jsonb(p) order by completed_at desc,id desc) from page p),'[]'),
   'transactions',coalesce((select jsonb_agg(to_jsonb(t) order by created_at desc,id desc) from points_transactions t where family_id=a.family_id and member_id=target and task_id in (select task_id from page)),'[]')) into result;
  return result;
 elsif p_kind='leaderboard' then
  -- Aggregation stays private. Only display columns and aggregate totals leave SQL.
  select coalesce(jsonb_agg(jsonb_build_object('memberId',m.id,'name',m.name,'avatarUrl',m.avatar_url,'color',m.color,'points',coalesce(t.points,0),'completedTasks',coalesce(t.count,0))),'[]') into result from family_members m
  left join lateral (select sum(points) points,count(*) filter(where transaction_type='TASK_COMPLETION' and points>0) count from points_transactions where family_id=a.family_id and member_id=m.id and (lower_bound is null or created_at>=lower_bound) and created_at<=stamp) t on true
  where m.family_id=a.family_id and m.active;
  return jsonb_build_object('entries',result,'asOf',stamp);
 elsif p_kind='dashboard' then
  target:=a.member_id;if target is null then raise exception 'FORBIDDEN'; end if;
  select jsonb_build_object(
   'family',(select jsonb_build_object('id',id,'name',name,'avatar_url',avatar_url) from families where id=a.family_id),
   'member',(select jsonb_build_object('id',id,'name',name,'avatar_url',avatar_url,'color',color,'member_type',member_type,'birth_year',birth_year,'active',active) from family_members where id=target and family_id=a.family_id),
   'balance',(select coalesce(sum(points),0) from points_transactions where family_id=a.family_id and member_id=target),
   'todayTasks',coalesce((select jsonb_agg(to_jsonb(t)-'created_by_user_id'-'created_by_app_user_id' order by t.due_time nulls last,t.id) from tasks t where family_id=a.family_id and assigned_member_id=target and due_date=(stamp at time zone 'UTC')::date),'[]'),
   'upcomingTasks',coalesce((select jsonb_agg(to_jsonb(t)-'created_by_user_id'-'created_by_app_user_id' order by t.due_date,t.due_time nulls last,t.id) from (select * from tasks where family_id=a.family_id and assigned_member_id=target and status<>'DONE' and due_date>(stamp at time zone 'UTC')::date order by due_date,due_time nulls last,id limit 10) t),'[]'),
   'recentTransactions',coalesce((select jsonb_agg(to_jsonb(t) order by created_at desc,id desc) from (select * from points_transactions where family_id=a.family_id and member_id=target and created_at<=stamp order by created_at desc,id desc limit 10) t),'[]'),
   'recentCompletions',coalesce((select jsonb_agg(to_jsonb(t) order by completed_at desc,id desc) from (select id,task_id,family_id,completed_by_member_id,completed_at,(select coalesce(sum(p.points),0) from points_transactions p where p.family_id=a.family_id and p.member_id=target and p.task_id=task_completions.task_id and p.transaction_type='TASK_COMPLETION' and p.points>0 and p.created_at>=task_completions.completed_at) awarded_points,(select title from tasks where tasks.id=task_completions.task_id and tasks.family_id=a.family_id) task_title from task_completions where family_id=a.family_id and completed_by_member_id=target and completed_at<=stamp order by completed_at desc,id desc limit 10) t),'[]'),'asOf',stamp) into result;
  return result;
 end if;
 raise exception 'VALIDATION';
end $$;
revoke all on function member_view_read(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function member_view_read(uuid,text,jsonb) to service_role;
commit;
