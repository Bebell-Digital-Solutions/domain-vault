-- ============================================================================
-- Domain Vault — yearly subscriptions
--
-- The owner's PayPal buttons are yearly subscriptions for all four plans
-- (Personal 29, Start-up 48, Business 79, Agency 98 USD). One-time payments
-- stay possible for "lifetime deals". So a paid plan now has an end date:
--
--   * Each subscription payment grants its plan until a year after the
--     payment, plus a few days' grace for PayPal's retry schedule. The next
--     yearly payment extends it; when payments stop, the plan lapses by
--     itself even if PayPal's "end of term" message never arrives.
--   * A lifetime purchase grants its plan with no end date, as before.
--   * plan_prices.amount is the yearly price; lifetime_amount the one-time
--     price. The webhook checks a payment against the price for its kind, so
--     a crafted one-time payment of the yearly price buys nothing.
--
-- What an account without a paid plan gets, and whether new sign-ups wait
-- for approval, are admin settings (billing_config), changed from the admin
-- panel. The defaults keep today's behaviour.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The Free tier (added to the enum by the previous migration).
-- ---------------------------------------------------------------------------
insert into public.plan_limits (plan, domain_limit, rank) values ('Free', 0, -1)
on conflict (plan) do update set domain_limit = excluded.domain_limit, rank = excluded.rank;

-- ---------------------------------------------------------------------------
-- billing_config — one row of owner decisions.
-- ---------------------------------------------------------------------------
create table if not exists public.billing_config (
  id               boolean primary key default true check (id),
  unpaid_plan      public.plan_tier not null default 'Personal',
  require_approval boolean not null default true,
  grace_days       integer not null default 3,
  updated_at       timestamptz not null default now(),
  constraint billing_config_unpaid_plan check (unpaid_plan in ('Free', 'Personal')),
  constraint billing_config_grace check (grace_days between 0 and 30)
);

insert into public.billing_config (id) values (true) on conflict (id) do nothing;

drop trigger if exists billing_config_set_updated_at on public.billing_config;
create trigger billing_config_set_updated_at
  before update on public.billing_config
  for each row execute function public.set_updated_at();

-- Read and written by the api function (service role) only.
alter table public.billing_config enable row level security;
revoke all on public.billing_config from anon, authenticated;

-- ---------------------------------------------------------------------------
-- plan_prices — yearly and lifetime prices; Personal is now for sale.
-- ---------------------------------------------------------------------------
alter table public.plan_prices add column if not exists lifetime_amount numeric(12,2);

alter table public.plan_prices drop constraint if exists plan_prices_lifetime_positive;
alter table public.plan_prices add constraint plan_prices_lifetime_positive
  check (lifetime_amount is null or lifetime_amount > 0);

insert into public.plan_prices (plan) values ('Personal') on conflict (plan) do nothing;

comment on column public.plan_prices.amount is
  'Yearly subscription price; null = no subscription sold. Must equal the PayPal subscription button.';
comment on column public.plan_prices.lifetime_amount is
  'One-time (lifetime deal) price; null = no lifetime deal sold. Must equal the PayPal Buy Now button.';

-- ---------------------------------------------------------------------------
-- purchases — which kind of payment, and how long it grants its plan.
-- ---------------------------------------------------------------------------
alter table public.purchases
  add column if not exists kind       text,
  add column if not exists subscr_id  text,
  add column if not exists paid_until timestamptz;

-- Everything recorded so far was a one-time purchase.
update public.purchases set kind = 'lifetime' where kind is null;

alter table public.purchases alter column kind set default 'lifetime';
alter table public.purchases alter column kind set not null;
alter table public.purchases drop constraint if exists purchases_kind_valid;
alter table public.purchases add constraint purchases_kind_valid
  check (kind in ('lifetime', 'subscription'));

create index if not exists purchases_subscr_idx on public.purchases (subscr_id)
  where subscr_id is not null;

comment on column public.purchases.paid_until is
  'End of what this payment grants; null = no end (lifetime).';

-- ---------------------------------------------------------------------------
-- subscriptions — one row per PayPal subscription, for the customer's
-- billing page and the admin panel. Entitlement itself comes from the
-- payments in purchases, not from this table.
--
-- status:
--   active     signed up and not cancelled
--   cancelled  the customer cancelled; paid time runs out normally
--   ended      PayPal reported the end of term (or it was refunded away)
--   rejected   wrong amount, period or plan; nothing granted
--   unmatched  no account with that email; nothing granted
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  subscr_id    text primary key,
  user_id      uuid references auth.users (id) on delete set null,
  email        text,
  payer_email  text,
  plan         public.plan_tier,
  amount       numeric(12,2),
  currency     text,
  period       text,
  status       text not null default 'active',
  reason       text,
  started_at   timestamptz not null default now(),
  cancelled_at timestamptz,
  ended_at     timestamptz,
  updated_at   timestamptz not null default now(),
  constraint subscriptions_status_valid check (status in
    ('active', 'cancelled', 'ended', 'rejected', 'unmatched'))
);

create index if not exists subscriptions_user_idx on public.subscriptions (user_id);

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

alter table public.subscriptions enable row level security;

drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.subscriptions from anon;
revoke insert, update, delete on public.subscriptions from authenticated;
-- Explicit rather than relying on the platform's default grants; the policy
-- above limits it to the customer's own rows.
grant select on public.subscriptions to authenticated;

-- ---------------------------------------------------------------------------
-- recompute_plan — now with end dates and a configurable base plan.
--
--   effective plan = plan_override, if an admin set one
--                  = otherwise the highest-ranked plan with a completed
--                    payment that is still running (lifetime, or a
--                    subscription payment whose paid_until is in the future)
--                  = otherwise billing_config.unpaid_plan
--
-- As before: a first completed payment activates a pending account, never a
-- suspended one, and a downgrade never deletes domains.
-- ---------------------------------------------------------------------------
create or replace function public.recompute_plan(p_user uuid)
returns public.plan_tier
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_override  public.plan_tier;
  v_purchased public.plan_tier;
  v_base      public.plan_tier;
  v_plan      public.plan_tier;
begin
  select plan_override into v_override from public.profiles where id = p_user;

  select pu.plan into v_purchased
    from public.purchases pu
    join public.plan_limits pl on pl.plan = pu.plan
   where pu.user_id = p_user
     and pu.status = 'completed'
     and (pu.paid_until is null or pu.paid_until > now())
   order by pl.rank desc
   limit 1;

  select unpaid_plan into v_base from public.billing_config where id;
  v_plan := coalesce(v_override, v_purchased, v_base, 'Personal');

  update public.profiles
     set plan   = v_plan,
         status = case when v_purchased is not null and status = 'pending'
                       then 'active' else status end
   where id = p_user;

  return v_plan;
end;
$$;

revoke all on function public.recompute_plan(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- refresh_plans — recompute stored plans in bulk.
--
--   refresh_plans(false)  accounts with a subscription payment: run hourly,
--                         so a lapsed subscription is downgraded on time.
--   refresh_plans(true)   every account: after an admin changes unpaid_plan.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_plans(p_all boolean default false)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user  uuid;
  v_count integer := 0;
begin
  for v_user in
    select p.id from public.profiles p
     where p_all
        or exists (select 1 from public.purchases pu
                    where pu.user_id = p.id and pu.kind = 'subscription')
  loop
    perform public.recompute_plan(v_user);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.refresh_plans(boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Hourly expiry sweep.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron unavailable; run select public.refresh_plans() hourly yourself.';
    return;
  end if;

  perform cron.unschedule(jobid) from cron.job where jobname = 'domain-vault-subscriptions';
  perform cron.schedule('domain-vault-subscriptions', '7 * * * *',
    $job$ select public.refresh_plans(false); $job$);
end $$;
