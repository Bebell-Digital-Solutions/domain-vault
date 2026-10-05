\set QUIET on
\set ON_ERROR_STOP on
-- Supabase grants these to the authenticated role by default; recreate that
-- baseline so the migration's own revokes are tested on top of it. Function
-- EXECUTE comes from the default privileges in 00_stubs.sql, applied as each
-- function is created, so a migration's revoke still takes effect.
grant select, insert, update, delete on public.profiles, public.providers,
  public.domains, public.settings, public.notifications to authenticated;
grant select on public.plan_limits to authenticated;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'alice@example.com'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'bob@example.com');
update public.profiles set status = 'active';
\set QUIET off

\echo '--- T1: signup trigger provisioned profile + settings'
select (select count(*) from public.profiles) = 2
   and (select count(*) from public.settings) = 2 as t1_pass;

\echo '--- T2: alice syncs 3 domains'
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','aaaaaaaa-0000-4000-8000-000000000001',true);
  execute 'set local role authenticated';
  select count(*) into n from public.sync_domains('[
    {"name":"one.com","renewalDate":"2027-01-01","renewalPrice":"12.50","autoRenew":true},
    {"name":"two.com","renewalDate":"2027-02-01"},
    {"name":"three.com","renewalDate":"2027-03-01"}]'::jsonb);
  raise notice '%', case when n = 3 then 'PASS t2 (3 domains)' else 'FAIL t2 got '||n end;
end $$;

\echo '--- T3: bob cannot see alice''s rows (RLS)'
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','bbbbbbbb-0000-4000-8000-000000000002',true);
  execute 'set local role authenticated';
  select count(*) into n from public.domains;
  raise notice '%', case when n = 0 then 'PASS t3 (isolated)' else 'FAIL t3 leaked '||n end;
end $$;

\echo '--- T4: plan limit (Personal = 5) is enforced server-side'
do $$
begin
  perform set_config('request.jwt.claim.sub','aaaaaaaa-0000-4000-8000-000000000001',true);
  execute 'set local role authenticated';
  perform public.sync_domains('[
    {"name":"a1.com"},{"name":"a2.com"},{"name":"a3.com"},
    {"name":"a4.com"},{"name":"a5.com"},{"name":"a6.com"}]'::jsonb);
  raise notice 'FAIL t4: 6 domains accepted on a 5-domain plan';
exception when others then
  raise notice 'PASS t4 (%)', sqlerrm;
end $$;

\echo '--- T5: at the limit, swapping one domain for another still works'
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','aaaaaaaa-0000-4000-8000-000000000001',true);
  execute 'set local role authenticated';
  perform public.sync_domains('[
    {"name":"a1.com"},{"name":"a2.com"},{"name":"a3.com"},
    {"name":"a4.com"},{"name":"a5.com"}]'::jsonb);
  -- drop a5, add a6: still 5, must not trip the limit
  select count(*) into n from public.sync_domains('[
    {"name":"a1.com"},{"name":"a2.com"},{"name":"a3.com"},
    {"name":"a4.com"},{"name":"a6.com"}]'::jsonb);
  raise notice '%', case when n = 5 then 'PASS t5 (swap at limit)' else 'FAIL t5 got '||n end;
exception when others then
  raise notice 'FAIL t5 (%)', sqlerrm;
end $$;

\echo '--- T6: a user cannot promote their own plan'
do $$
begin
  perform set_config('request.jwt.claim.sub','aaaaaaaa-0000-4000-8000-000000000001',true);
  execute 'set local role authenticated';
  update public.profiles set plan = 'Agency'
   where id = 'aaaaaaaa-0000-4000-8000-000000000001';
  raise notice 'FAIL t6: self-upgrade succeeded';
exception when others then
  raise notice 'PASS t6 (%)', sqlerrm;
end $$;

\echo '--- T7: cannot delete a provider that still has domains'
do $$
begin
  perform set_config('request.jwt.claim.sub','aaaaaaaa-0000-4000-8000-000000000001',true);
  execute 'set local role authenticated';
  perform public.sync_providers('[{"name":"Namecheap","url":"https://namecheap.com"}]'::jsonb);
  perform public.sync_domains('[{"name":"a1.com","provider":"Namecheap"}]'::jsonb);
  perform public.sync_providers('[]'::jsonb);
  raise notice 'FAIL t7: provider with domains was removed';
exception when others then
  raise notice 'PASS t7 (%)', sqlerrm;
end $$;

\echo '--- T8: suspended account is locked out by the database'
do $$
declare n int;
begin
  update public.profiles set status = 'suspended'
   where id = 'aaaaaaaa-0000-4000-8000-000000000001';
  perform set_config('request.jwt.claim.sub','aaaaaaaa-0000-4000-8000-000000000001',true);
  execute 'set local role authenticated';
  select count(*) into n from public.domains;
  raise notice '%', case when n = 0 then 'PASS t8 (locked out)' else 'FAIL t8 read '||n end;
end $$;

\echo '--- T9: rate limiter is atomic and actually stops at the limit'
select public.consume_rate_limit('t9', 2, 60) as first,
       public.consume_rate_limit('t9', 2, 60) as second,
       public.consume_rate_limit('t9', 2, 60) as third_should_be_false;

-- ===========================================================================
-- Billing and admin (20260917000100)
-- ===========================================================================
\set QUIET on
grant select, insert, update, delete on public.purchases to authenticated;
insert into auth.users (id, email) values
  ('cccccccc-0000-4000-8000-000000000003', 'carol@example.com'),
  ('dddddddd-0000-4000-8000-000000000004', 'dave@example.com');
update public.profiles set status = 'active' where email = 'dave@example.com';
\set QUIET off

\echo '--- T10: a user cannot make themselves admin'
do $$
begin
  perform set_config('request.jwt.claim.sub','dddddddd-0000-4000-8000-000000000004',true);
  execute 'set local role authenticated';
  update public.profiles set is_admin = true where id = 'dddddddd-0000-4000-8000-000000000004';
  raise notice 'FAIL t10: self-granted admin';
exception when others then
  raise notice 'PASS t10 (%)', sqlerrm;
end $$;

\echo '--- T11: a user cannot set their own plan override'
do $$
begin
  perform set_config('request.jwt.claim.sub','dddddddd-0000-4000-8000-000000000004',true);
  execute 'set local role authenticated';
  update public.profiles set plan_override = 'Agency' where id = 'dddddddd-0000-4000-8000-000000000004';
  raise notice 'FAIL t11: self-granted override';
exception when others then
  raise notice 'PASS t11 (%)', sqlerrm;
end $$;

\echo '--- T12: a user cannot write their own purchase'
do $$
begin
  perform set_config('request.jwt.claim.sub','dddddddd-0000-4000-8000-000000000004',true);
  execute 'set local role authenticated';
  insert into public.purchases (txn_id, user_id, plan, amount, currency, status)
  values ('FORGED', 'dddddddd-0000-4000-8000-000000000004', 'Agency', 0.01, 'USD', 'completed');
  raise notice 'FAIL t12: forged a purchase';
exception when others then
  raise notice 'PASS t12 (%)', sqlerrm;
end $$;

\echo '--- T13: plan follows the ledger (buy, upgrade, refund, override)'
do $$
declare
  u uuid := 'cccccccc-0000-4000-8000-000000000003';
  steps text := '';
  got text;
begin
  -- carol is pending; her first completed purchase must activate her
  insert into public.purchases (txn_id, user_id, plan, amount, currency, status)
  values ('T-BIZ', u, 'Business', 99, 'USD', 'completed');
  perform public.recompute_plan(u);
  select plan || '/' || status into got from public.profiles where id = u;
  steps := steps || got || ' ';

  insert into public.purchases (txn_id, user_id, plan, amount, currency, status)
  values ('T-AGY', u, 'Agency', 299, 'USD', 'completed');
  perform public.recompute_plan(u);
  select plan into got from public.profiles where id = u;
  steps := steps || got || ' ';

  update public.purchases set status = 'refunded' where txn_id = 'T-AGY';
  perform public.recompute_plan(u);
  select plan into got from public.profiles where id = u;
  steps := steps || got || ' ';

  update public.profiles set plan_override = 'Start-up' where id = u;
  perform public.recompute_plan(u);
  select plan into got from public.profiles where id = u;
  steps := steps || got || ' ';

  update public.profiles set plan_override = null where id = u;
  update public.purchases set status = 'reversed' where txn_id = 'T-BIZ';
  perform public.recompute_plan(u);
  select plan into got from public.profiles where id = u;
  steps := steps || got;

  raise notice '%', case
    when steps = 'Business/active Agency Business Start-up Personal'
      then 'PASS t13 (' || steps || ')'
    else 'FAIL t13 got: ' || steps end;
end $$;

\echo '--- T14: a purchase never reactivates a suspended account'
do $$
declare got text;
begin
  update public.profiles set status = 'suspended' where email = 'dave@example.com';
  insert into public.purchases (txn_id, user_id, plan, amount, currency, status)
  values ('T-SUS', 'dddddddd-0000-4000-8000-000000000004', 'Start-up', 29, 'USD', 'completed');
  perform public.recompute_plan('dddddddd-0000-4000-8000-000000000004');
  select plan || '/' || status into got from public.profiles where email = 'dave@example.com';
  raise notice '%', case when got = 'Start-up/suspended'
    then 'PASS t14 (' || got || ')' else 'FAIL t14 got ' || got end;
end $$;

\echo '--- T15: customers see only their own purchases'
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','bbbbbbbb-0000-4000-8000-000000000002',true);
  execute 'set local role authenticated';
  select count(*) into n from public.purchases;
  raise notice '%', case when n = 0 then 'PASS t15 (isolated)' else 'FAIL t15 saw '||n end;
end $$;

-- ===========================================================================
-- Renewal reminders (20260928000100)
-- ===========================================================================
\set QUIET on
insert into auth.users (id, email) values
  ('eeeeeeee-0000-4000-8000-000000000005', 'rem@example.com');
update public.profiles set status = 'active', phone = '+10000000001'
 where email = 'rem@example.com';
\set QUIET off

\echo '--- T16: a domain added mid-cycle still gets one reminder'
do $$
declare u uuid := 'eeeeeeee-0000-4000-8000-000000000005'; got text;
begin
  -- 20 days out: the old exact-match sweep sent nothing until day 7.
  insert into public.domains (user_id, name, renewal_date)
  values (u, 'midcycle.com', current_date + 20);
  select milestone || ' (' || days_left || 'd left)' into got
    from public.due_reminders(current_date) where domain_name = 'midcycle.com';
  raise notice '%', case when got = '30 (20d left)'
    then 'PASS t16 milestone ' || got else 'FAIL t16 got ' || coalesce(got, 'nothing') end;
end $$;

\echo '--- T17: only the most urgent milestone fires, never a backlog'
do $$
declare n int; got int;
begin
  update public.domains set renewal_date = current_date + 3 where name = 'midcycle.com';
  select count(*), min(milestone) into n, got
    from public.due_reminders(current_date) where domain_name = 'midcycle.com';
  raise notice '%', case when n = 1 and got = 7
    then 'PASS t17 (one reminder, milestone 7)' else 'FAIL t17 count=' || n || ' milestone=' || got end;
end $$;

\echo '--- T18: once sent, the same milestone does not fire again'
do $$
declare n int;
begin
  insert into public.notifications (user_id, domain_id, domain_name, renewal_date, diff_days, type, channel)
  select user_id, domain_id, domain_name, renewal_date, milestone, 'renewal', 'email'
    from public.due_reminders(current_date) where domain_name = 'midcycle.com';
  select count(*) into n from public.due_reminders(current_date) where domain_name = 'midcycle.com';
  raise notice '%', case when n = 0 then 'PASS t18 (silent after sending)' else 'FAIL t18 got ' || n end;
end $$;

\echo '--- T19: as it gets closer, the next milestone fires'
do $$
declare got int;
begin
  update public.domains set renewal_date = current_date + 1 where name = 'midcycle.com';
  select milestone into got from public.due_reminders(current_date) where domain_name = 'midcycle.com';
  raise notice '%', case when got = 1 then 'PASS t19 (milestone 1)' else 'FAIL t19 got ' || coalesce(got::text,'nothing') end;
end $$;

\echo '--- T20: renewing a domain starts a fresh cycle of reminders'
do $$
declare got int;
begin
  -- Tell them about every milestone of the current cycle.
  insert into public.notifications (user_id, domain_id, domain_name, renewal_date, diff_days, type, channel)
  select user_id, domain_id, domain_name, renewal_date, milestone, 'renewal', 'email'
    from public.due_reminders(current_date) where domain_name = 'midcycle.com';
  -- Customer renews for another year. The old scheme stayed silent forever.
  update public.domains set renewal_date = current_date + 30 where name = 'midcycle.com';
  select milestone into got from public.due_reminders(current_date) where domain_name = 'midcycle.com';
  raise notice '%', case when got = 30
    then 'PASS t20 (new cycle reminds again)' else 'FAIL t20 got ' || coalesce(got::text, 'nothing') end;
end $$;

\echo '--- T21: expired domains are left alone'
do $$
declare n int;
begin
  update public.domains set renewal_date = current_date - 2 where name = 'midcycle.com';
  select count(*) into n from public.due_reminders(current_date) where domain_name = 'midcycle.com';
  raise notice '%', case when n = 0 then 'PASS t21 (no nagging after expiry)' else 'FAIL t21 got ' || n end;
end $$;

\echo '--- T22: the expiry day itself is covered'
do $$
declare got int;
begin
  update public.domains set renewal_date = current_date where name = 'midcycle.com';
  select milestone into got from public.due_reminders(current_date) where domain_name = 'midcycle.com';
  raise notice '%', case when got = 0 then 'PASS t22 (expires today)' else 'FAIL t22 got ' || coalesce(got::text,'nothing') end;
end $$;

\echo '--- T23: preferences are respected (off, channels, custom lead days)'
do $$
declare u uuid := 'eeeeeeee-0000-4000-8000-000000000005'; n_off int; n_wa int; n_lead int;
begin
  update public.domains set renewal_date = current_date + 14 where name = 'midcycle.com';

  update public.settings set reminders_enabled = false where user_id = u;
  select count(*) into n_off from public.due_reminders(current_date);

  update public.settings set reminders_enabled = true, reminder_channels = array['whatsapp'] where user_id = u;
  select count(*) into n_wa from public.due_reminders(current_date, 'email');

  update public.settings set reminder_channels = array['email'], reminder_lead_days = array[1] where user_id = u;
  select count(*) into n_lead from public.due_reminders(current_date);

  raise notice '%', case when n_off = 0 and n_wa = 0 and n_lead = 0
    then 'PASS t23 (opt-out, channel and lead-day choices all honoured)'
    else 'FAIL t23 off=' || n_off || ' wrongChannel=' || n_wa || ' leadDays=' || n_lead end;
end $$;

\echo '--- T24: suspended accounts get no reminders'
do $$
declare n int;
begin
  update public.settings set reminder_lead_days = array[30,7,1,0] where user_id = 'eeeeeeee-0000-4000-8000-000000000005';
  update public.profiles set status = 'suspended' where email = 'rem@example.com';
  select count(*) into n from public.due_reminders(current_date);
  raise notice '%', case when n = 0 then 'PASS t24 (suspended is silent)' else 'FAIL t24 got ' || n end;
end $$;

-- ===========================================================================
-- Calendar subscription feed (20261005000100)
-- ===========================================================================
\set QUIET on
insert into auth.users (id, email) values
  ('ffffffff-0000-4000-8000-000000000006', 'cal@example.com');
update public.profiles set status = 'active' where email = 'cal@example.com';
insert into public.calendar_feeds (user_id, token) values
  ('ffffffff-0000-4000-8000-000000000006', 'calTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
\set QUIET off

\echo '--- T25: a feed shows its owner''s dated renewals, and only those'
do $$
declare n int; n_unknown int; foreign_rows int;
begin
  perform set_config('request.jwt.claim.sub','ffffffff-0000-4000-8000-000000000006',true);
  execute 'set local role authenticated';
  perform public.sync_domains('[
    {"name":"feed-one.com","renewalDate":"2027-04-01","renewalPrice":"9.99"},
    {"name":"feed-two.com","renewalDate":"2027-05-01"},
    {"name":"undated.com"}]'::jsonb);
  execute 'reset role';

  select count(*) into n from public.calendar_feed('calTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  select count(*) into n_unknown from public.calendar_feed('nopeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  select count(*) into foreign_rows
    from public.calendar_feed('calTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') f
   where f.domain_name not like 'feed-%';

  raise notice '%', case when n = 2 and n_unknown = 0 and foreign_rows = 0
    then 'PASS t25 (2 dated renewals, unknown token empty, no other user''s rows)'
    else 'FAIL t25 n=' || n || ' unknown=' || n_unknown || ' foreign=' || foreign_rows end;
end $$;

\echo '--- T26: users cannot read feed tokens or call the feed function'
do $$
declare blocked_table boolean := false; blocked_fn boolean := false;
begin
  perform set_config('request.jwt.claim.sub','ffffffff-0000-4000-8000-000000000006',true);
  execute 'set local role authenticated';
  begin
    perform 1 from public.calendar_feeds;
  exception when insufficient_privilege then blocked_table := true;
  end;
  begin
    perform 1 from public.calendar_feed('calTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  exception when insufficient_privilege then blocked_fn := true;
  end;
  execute 'reset role';
  raise notice '%', case when blocked_table and blocked_fn
    then 'PASS t26 (tokens and feed are service-role only)'
    else 'FAIL t26 table=' || blocked_table || ' fn=' || blocked_fn end;
end $$;

\echo '--- T27: a suspended account''s feed goes dark; malformed tokens are refused'
do $$
declare n int; rejected boolean := false;
begin
  update public.profiles set status = 'suspended' where email = 'cal@example.com';
  select count(*) into n from public.calendar_feed('calTokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  begin
    insert into public.calendar_feeds (user_id, token)
    values ('aaaaaaaa-0000-4000-8000-000000000001', 'short');
  exception when check_violation then rejected := true;
  end;
  raise notice '%', case when n = 0 and rejected
    then 'PASS t27 (suspended feed empty, short token rejected)'
    else 'FAIL t27 rows=' || n || ' rejected=' || rejected end;
end $$;
