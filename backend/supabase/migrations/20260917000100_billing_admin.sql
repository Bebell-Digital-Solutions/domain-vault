-- ============================================================================
-- Domain Vault — one-time purchases, admin role, audit trail
--
-- Business model (agreed with Bebell, 2026-09-16): PayPal only, no
-- subscriptions. A customer pays once for a domain pack and keeps it.
--
-- The plan a user holds is no longer written directly by the webhook. It is
-- DERIVED from their purchase ledger by recompute_plan(), so a refund or a
-- chargeback automatically takes back exactly what that payment granted, and
-- an admin override can be applied and removed without losing track of what
-- the customer actually paid for.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tier ordering. "Highest tier purchased wins" needs a rank.
-- ---------------------------------------------------------------------------
alter table public.plan_limits add column if not exists rank integer;
update public.plan_limits set rank = case plan
  when 'Personal' then 0 when 'Start-up' then 1
  when 'Business' then 2 when 'Agency'   then 3 end;
alter table public.plan_limits alter column rank set not null;

-- ---------------------------------------------------------------------------
-- plan_prices — what each pack costs. The payment webhook refuses any payment
-- whose amount or currency does not match this table exactly.
--
-- Without this check, anyone could craft their own PayPal payment to our
-- account with item_name "Agency" and an amount of 0.01. PayPal would verify
-- it as genuine — because it is a genuine payment — and the plan would be
-- granted.
--
-- amount is NULL until the real price is set, and a pack with no price
-- cannot be bought. Set prices with:
--   update plan_prices set amount = 49.00, currency = 'USD' where plan = 'Start-up';
-- ---------------------------------------------------------------------------
create table if not exists public.plan_prices (
  plan       public.plan_tier primary key,
  amount     numeric(12,2),
  currency   text not null default 'USD',
  updated_at timestamptz not null default now(),
  constraint plan_prices_positive check (amount is null or amount > 0),
  constraint plan_prices_currency check (currency ~ '^[A-Z]{3}$')
);

insert into public.plan_prices (plan) values ('Start-up'), ('Business'), ('Agency')
on conflict (plan) do nothing;

drop trigger if exists plan_prices_set_updated_at on public.plan_prices;
create trigger plan_prices_set_updated_at
  before update on public.plan_prices
  for each row execute function public.set_updated_at();

alter table public.plan_prices enable row level security;

-- Prices are public information; the upgrade modal may show them.
drop policy if exists plan_prices_read on public.plan_prices;
create policy plan_prices_read on public.plan_prices
  for select to anon, authenticated
  using (true);
revoke insert, update, delete on public.plan_prices from anon, authenticated;

-- ---------------------------------------------------------------------------
-- profiles: admin flag and admin plan override
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists is_admin boolean not null default false;
alter table public.profiles add column if not exists plan_override public.plan_tier;

comment on column public.profiles.plan_override is
  'Set by an admin to grant or restrict a plan regardless of purchases. NULL = use purchases.';

-- Extend the privilege guard: is_admin and plan_override are as sensitive as
-- plan and status.
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
as $$
begin
  if public.is_privileged() then
    return new;
  end if;

  if new.plan is distinct from old.plan
     or new.plan_override is distinct from old.plan_override then
    raise exception 'plan may only be changed by the billing system'
      using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    raise exception 'account status may only be changed by an administrator'
      using errcode = '42501';
  end if;

  if new.is_admin is distinct from old.is_admin then
    raise exception 'admin rights may only be granted by an administrator'
      using errcode = '42501';
  end if;

  new.id    := old.id;
  new.email := old.email;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- purchases — the ledger. One row per PayPal transaction that concerns us,
-- including the ones we refused, so an admin can see and resolve them.
--
-- status:
--   completed  money received, pack granted
--   pending    PayPal has not cleared it yet (e.g. eCheck); nothing granted
--   refunded   money returned; grant withdrawn
--   reversed   chargeback; grant withdrawn
--   rejected   paid, but amount/currency/pack did not match; nothing granted
--   unmatched  paid, but no account has that email; nothing granted
--   failed     denied / failed / voided at PayPal
-- ---------------------------------------------------------------------------
create table if not exists public.purchases (
  id          uuid primary key default gen_random_uuid(),
  txn_id      text not null unique,
  user_id     uuid references auth.users (id) on delete set null,
  email       text,
  payer_email text,
  plan        public.plan_tier,
  amount      numeric(12,2),
  currency    text,
  status      text not null,
  reason      text,
  source      text not null default 'paypal',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint purchases_status_valid check (status in
    ('completed','pending','refunded','reversed','rejected','unmatched','failed')),
  constraint purchases_source_valid check (source in ('paypal','admin'))
);

create index if not exists purchases_user_idx on public.purchases (user_id, created_at desc);
create index if not exists purchases_status_idx on public.purchases (status, created_at desc);

drop trigger if exists purchases_set_updated_at on public.purchases;
create trigger purchases_set_updated_at
  before update on public.purchases
  for each row execute function public.set_updated_at();

alter table public.purchases enable row level security;

-- Customers can see their own purchase history; nobody can write to it
-- except the service role.
drop policy if exists purchases_select_own on public.purchases;
create policy purchases_select_own on public.purchases
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.purchases from anon;
revoke insert, update, delete on public.purchases from authenticated;

-- ---------------------------------------------------------------------------
-- recompute_plan — the single place a user's effective plan is decided.
--
--   effective plan = plan_override, if an admin set one
--                  = otherwise the highest-ranked pack with a completed
--                    purchase
--                  = otherwise Personal
--
-- A first completed purchase also activates a pending account: someone who
-- has paid should not also wait for manual approval. It never reactivates a
-- suspended account.
--
-- Downgrading never deletes domains. A user left above their new limit keeps
-- what they have and simply cannot add more.
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
  v_paid      boolean;
  v_plan      public.plan_tier;
begin
  select plan_override into v_override from public.profiles where id = p_user;

  select pu.plan into v_purchased
    from public.purchases pu
    join public.plan_limits pl on pl.plan = pu.plan
   where pu.user_id = p_user and pu.status = 'completed'
   order by pl.rank desc
   limit 1;

  v_paid := v_purchased is not null;
  v_plan := coalesce(v_override, v_purchased, 'Personal');

  update public.profiles
     set plan   = v_plan,
         status = case when v_paid and status = 'pending' then 'active' else status end
   where id = p_user;

  return v_plan;
end;
$$;

revoke all on function public.recompute_plan(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- admin_audit_log — every change an admin makes, with before/after.
-- ---------------------------------------------------------------------------
create table if not exists public.admin_audit_log (
  id             uuid primary key default gen_random_uuid(),
  admin_id       uuid references auth.users (id) on delete set null,
  admin_email    text,
  target_user_id uuid references auth.users (id) on delete set null,
  target_email   text,
  action         text not null,
  details        jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists admin_audit_created_idx on public.admin_audit_log (created_at desc);

alter table public.admin_audit_log enable row level security;
-- No policies: read and written only through the api function, after it has
-- verified the caller is an admin.
revoke all on public.admin_audit_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- admin_domain_counts — domains per user for the admin user list, counted in
-- the database instead of shipping every domain row to the function.
-- ---------------------------------------------------------------------------
create or replace function public.admin_domain_counts(p_users uuid[])
returns table (user_id uuid, domain_count bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.user_id, count(*)
    from public.domains d
   where d.user_id = any (p_users)
   group by d.user_id;
$$;

revoke all on function public.admin_domain_counts(uuid[]) from public, anon, authenticated;
