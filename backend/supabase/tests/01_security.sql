\set QUIET on
\set ON_ERROR_STOP on
-- Supabase grants these to the authenticated role by default; recreate that
-- baseline so the migration's own revokes are tested on top of it.
grant select, insert, update, delete on public.profiles, public.providers,
  public.domains, public.settings, public.notifications to authenticated;
grant select on public.plan_limits to authenticated;
grant execute on all functions in schema public to authenticated;

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
