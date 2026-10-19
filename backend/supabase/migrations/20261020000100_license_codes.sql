-- ============================================================================
-- Domain Vault — license codes (AppSumo, SaaSZilla and other marketplaces)
--
-- A marketplace sells Domain Vault and hands each buyer a code. The buyer
-- redeems it in the app (sign-up, log-in, or Settings → License keys).
-- Codes stack, up to 4 per account, and are lifetime:
--
--     1 code  Personal      3 codes  Business
--     2 codes Start-up      4 codes  Agency
--
-- A redemption is recorded in the purchase ledger as one "license codes" row
-- per account (txn_id 'codes:<user>'), so recompute_plan treats it like any
-- lifetime purchase: the best plan the account holds wins, and a pending
-- account is activated without anyone approving it.
--
-- Only a SHA-256 of each code is stored: whoever reads the database cannot
-- redeem the codes. The plain codes exist once, in the CSV the admin
-- downloads when creating a batch.
-- ============================================================================

create table if not exists public.license_batches (
  id          uuid primary key default gen_random_uuid(),
  marketplace text not null,
  label       text not null default '',
  size        integer not null,
  created_by  text,
  created_at  timestamptz not null default now(),
  constraint license_batches_marketplace check (marketplace ~ '^[a-z0-9-]{2,30}$'),
  constraint license_batches_size check (size between 1 and 10000),
  constraint license_batches_label check (length(label) <= 100)
);

create table if not exists public.license_codes (
  code_hash     text primary key,
  batch_id      uuid not null references public.license_batches (id) on delete cascade,
  hint          text not null,
  status        text not null default 'available',
  redeemed_by   uuid references auth.users (id) on delete set null,
  redeemed_at   timestamptz,
  revoked_at    timestamptz,
  revoke_reason text,
  updated_at    timestamptz not null default now(),
  constraint license_codes_hash_shape check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint license_codes_hint_shape check (hint ~ '^[A-Z0-9]{4}$'),
  constraint license_codes_status check (status in ('available', 'redeemed', 'revoked'))
);

create index if not exists license_codes_user_idx on public.license_codes (redeemed_by) where redeemed_by is not null;
create index if not exists license_codes_batch_idx on public.license_codes (batch_id, status);

drop trigger if exists license_codes_set_updated_at on public.license_codes;
create trigger license_codes_set_updated_at
  before update on public.license_codes
  for each row execute function public.set_updated_at();

alter table public.license_batches enable row level security;
alter table public.license_codes enable row level security;
revoke all on public.license_batches, public.license_codes from anon, authenticated;

-- The ledger row of a code stack has its own source.
alter table public.purchases drop constraint if exists purchases_source_valid;
alter table public.purchases add constraint purchases_source_valid
  check (source in ('paypal', 'admin', 'license_code'));

-- ---------------------------------------------------------------------------
create or replace function public.license_plan(p_codes integer)
returns public.plan_tier
language sql
immutable
as $$
  select case
    when p_codes >= 4 then 'Agency'::public.plan_tier
    when p_codes = 3 then 'Business'::public.plan_tier
    when p_codes = 2 then 'Start-up'::public.plan_tier
    when p_codes = 1 then 'Personal'::public.plan_tier
  end;
$$;

-- Bring the account's ledger row in line with its redeemed codes, then
-- recompute its plan.
create or replace function public.apply_license_codes(p_user uuid)
returns public.plan_tier
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.license_codes
   where redeemed_by = p_user and status = 'redeemed';

  if v_count = 0 then
    update public.purchases
       set status = 'refunded', reason = 'no license codes left'
     where txn_id = 'codes:' || p_user and status = 'completed';
  else
    insert into public.purchases (txn_id, user_id, email, plan, amount, currency, status, source, kind, reason)
    select 'codes:' || p_user, p_user, p.email, public.license_plan(v_count), 0, 'USD', 'completed',
           'license_code', 'lifetime', v_count || ' license code(s)'
      from public.profiles p where p.id = p_user
    on conflict (txn_id) do update
       set plan = excluded.plan, status = 'completed', reason = excluded.reason, user_id = excluded.user_id;
  end if;

  return public.recompute_plan(p_user);
end;
$$;

-- Redeem one code for a user. Errors: P0002 unknown/used/revoked,
-- P0001 already on this account, P0003 already 4 codes.
create or replace function public.redeem_license_code(p_code_hash text, p_user uuid)
returns table (plan public.plan_tier, codes integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code  public.license_codes%rowtype;
  v_count integer;
begin
  select * into v_code from public.license_codes where code_hash = p_code_hash for update;
  if not found then
    raise exception 'unknown code' using errcode = 'P0002';
  end if;
  if v_code.status = 'revoked' then
    raise exception 'code revoked' using errcode = 'P0002';
  end if;
  if v_code.status = 'redeemed' then
    if v_code.redeemed_by = p_user then
      raise exception 'already on this account' using errcode = 'P0001';
    end if;
    raise exception 'code already used' using errcode = 'P0002';
  end if;

  -- Serialise redemptions per user so two at once cannot both be the 5th.
  perform 1 from public.profiles where id = p_user for update;
  select count(*) into v_count from public.license_codes where redeemed_by = p_user and status = 'redeemed';
  if v_count >= 4 then
    raise exception 'this account already has 4 codes (Agency)' using errcode = 'P0003';
  end if;

  update public.license_codes
     set status = 'redeemed', redeemed_by = p_user, redeemed_at = now()
   where code_hash = p_code_hash;

  plan := public.apply_license_codes(p_user);
  codes := v_count + 1;
  return next;
end;
$$;

-- Refunds: a revoked code stops counting; the account's plan follows.
create or replace function public.set_license_code_status(p_code_hash text, p_revoke boolean, p_reason text)
returns public.license_codes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code public.license_codes%rowtype;
begin
  select * into v_code from public.license_codes where code_hash = p_code_hash for update;
  if not found then
    raise exception 'unknown code' using errcode = 'P0002';
  end if;
  update public.license_codes
     set status = case when p_revoke then 'revoked'
                       when redeemed_by is not null then 'redeemed' else 'available' end,
         revoked_at = case when p_revoke then now() else null end,
         revoke_reason = case when p_revoke then left(p_reason, 200) else null end
   where code_hash = p_code_hash
  returning * into v_code;
  if v_code.redeemed_by is not null then
    perform public.apply_license_codes(v_code.redeemed_by);
  end if;
  return v_code;
end;
$$;

revoke all on function public.license_plan(integer) from public, anon, authenticated;
revoke all on function public.apply_license_codes(uuid) from public, anon, authenticated;
revoke all on function public.redeem_license_code(text, uuid) from public, anon, authenticated;
revoke all on function public.set_license_code_status(text, boolean, text) from public, anon, authenticated;

-- Codes per batch and status, for Admin → License codes.
create or replace function public.license_batch_counts()
returns table (batch_id uuid, status text, n bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select batch_id, status, count(*) from public.license_codes group by 1, 2;
$$;

revoke all on function public.license_batch_counts() from public, anon, authenticated;
