-- ============================================================================
-- Domain Vault — triggers, entitlement enforcement and sync RPCs
-- ============================================================================

-- ---------------------------------------------------------------------------
-- is_privileged — true for the service role and for direct admin connections.
-- ---------------------------------------------------------------------------
create or replace function public.is_privileged()
returns boolean
language sql
stable
as $$
  select current_user in ('service_role', 'postgres', 'supabase_admin');
$$;

-- ---------------------------------------------------------------------------
-- handle_new_user — provision profile + settings whenever Supabase Auth
-- creates a user. phone/location arrive in raw_user_meta_data from the signup
-- call, mirroring the old registerUser payload.
--
-- Accounts start 'pending', preserving the existing business rule that an
-- admin activates each account. Flip the default in plan_limits-style config
-- or activate via the admin panel.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, phone, location, status, plan)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    nullif(new.raw_user_meta_data ->> 'location', ''),
    'pending',
    'Personal'
  )
  on conflict (id) do nothing;

  insert into public.settings (user_id, username)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- guard_profile_privileges — a user may edit their own phone and location,
-- but must never be able to grant themselves a paid plan or activate their
-- own account. Without this, the profiles_update_own policy would happily
-- let someone PATCH plan='Agency'.
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
as $$
begin
  if public.is_privileged() then
    return new;
  end if;

  if new.plan is distinct from old.plan then
    raise exception 'plan may only be changed by the billing system'
      using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    raise exception 'account status may only be changed by an administrator'
      using errcode = '42501';
  end if;

  -- id and email are identity, not profile data.
  new.id    := old.id;
  new.email := old.email;

  return new;
end;
$$;

drop trigger if exists profiles_guard_privileges on public.profiles;
create trigger profiles_guard_privileges
  before update on public.profiles
  for each row execute function public.guard_profile_privileges();

-- ---------------------------------------------------------------------------
-- enforce_domain_limit — plan entitlements enforced server-side.
--
-- The frontend checks PLAN_LIMITS before opening the "add domain" modal, but
-- that is a UX affordance: anyone can edit the constant in devtools. This
-- trigger is the actual limit.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_domain_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer;
  v_count integer;
begin
  select pl.domain_limit
    into v_limit
    from public.profiles p
    join public.plan_limits pl on pl.plan = p.plan
   where p.id = new.user_id;

  -- null limit == unlimited (Agency)
  if v_limit is null then
    return new;
  end if;

  select count(*) into v_count
    from public.domains d
   where d.user_id = new.user_id;

  if v_count >= v_limit then
    raise exception 'domain limit reached for your plan (% of %)', v_count, v_limit
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists domains_enforce_limit on public.domains;
create trigger domains_enforce_limit
  before insert on public.domains
  for each row execute function public.enforce_domain_limit();

-- ---------------------------------------------------------------------------
-- sync_domains — replaces the old saveDomains, which deleted every row for a
-- user and then re-appended the whole array. That pattern loses all of a
-- user's data if the script times out midway, which Apps Script does.
--
-- This is one transaction: remove what the client dropped, then upsert what
-- it still has. A failure anywhere rolls the whole thing back.
--
-- Order matters. Deletes run first so that a user at their plan limit can
-- swap one domain for another in a single save without tripping
-- enforce_domain_limit.
--
-- SECURITY INVOKER, so RLS still applies: a caller cannot touch another
-- user's rows even by putting foreign ids in the payload.
-- ---------------------------------------------------------------------------
create or replace function public.sync_domains(p_domains jsonb)
returns setof public.domains
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if jsonb_typeof(p_domains) <> 'array' then
    raise exception 'p_domains must be a JSON array' using errcode = '22023';
  end if;

  delete from public.domains d
   where d.user_id = v_uid
     and d.id not in (
       select (e ->> 'id')::uuid
       from jsonb_array_elements(p_domains) as e
       where nullif(e ->> 'id', '') is not null
     );

  insert into public.domains as d
    (id, user_id, name, provider_name, purchase_date, renewal_date,
     purchase_price, renewal_price, auto_renew)
  select
    coalesce(nullif(e ->> 'id', '')::uuid, gen_random_uuid()),
    v_uid,
    btrim(e ->> 'name'),
    nullif(btrim(coalesce(e ->> 'provider', '')), ''),
    nullif(e ->> 'purchaseDate', '')::date,
    nullif(e ->> 'renewalDate', '')::date,
    coalesce(nullif(e ->> 'purchasePrice', '')::numeric, 0),
    coalesce(nullif(e ->> 'renewalPrice', '')::numeric, 0),
    coalesce((e ->> 'autoRenew')::boolean, false)
  from jsonb_array_elements(p_domains) as e
  where length(btrim(coalesce(e ->> 'name', ''))) > 0
  on conflict (id) do update set
    name           = excluded.name,
    provider_name  = excluded.provider_name,
    purchase_date  = excluded.purchase_date,
    renewal_date   = excluded.renewal_date,
    purchase_price = excluded.purchase_price,
    renewal_price  = excluded.renewal_price,
    auto_renew     = excluded.auto_renew
  where d.user_id = v_uid;

  return query
    select * from public.domains d
     where d.user_id = v_uid
     order by d.renewal_date nulls last, d.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- sync_providers — same contract for registrar accounts.
--
-- Secrets are NOT handled here. The api Edge Function writes provider_secrets
-- separately, because the encryption key must never be visible to the
-- database. A provider row losing its secret on rename is therefore
-- impossible: provider_secrets is keyed on the provider id, which is stable.
--
-- Removing a provider that still has domains attached is refused, matching
-- the guard the frontend already shows.
-- ---------------------------------------------------------------------------
create or replace function public.sync_providers(p_providers jsonb)
returns setof public.providers
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_orphaned text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if jsonb_typeof(p_providers) <> 'array' then
    raise exception 'p_providers must be a JSON array' using errcode = '22023';
  end if;

  -- Refuse to strand domains on a provider that is about to disappear.
  select string_agg(distinct d.provider_name, ', ')
    into v_orphaned
    from public.domains d
   where d.user_id = v_uid
     and d.provider_name is not null
     and lower(d.provider_name) not in (
       select lower(btrim(e ->> 'name'))
       from jsonb_array_elements(p_providers) as e
       where length(btrim(coalesce(e ->> 'name', ''))) > 0
     );

  if v_orphaned is not null then
    raise exception 'cannot remove provider(s) still linked to domains: %', v_orphaned
      using errcode = 'P0001';
  end if;

  delete from public.providers p
   where p.user_id = v_uid
     and p.id not in (
       select (e ->> 'id')::uuid
       from jsonb_array_elements(p_providers) as e
       where nullif(e ->> 'id', '') is not null
     );

  insert into public.providers as p (id, user_id, name, url, username, uid)
  select
    coalesce(nullif(e ->> 'id', '')::uuid, gen_random_uuid()),
    v_uid,
    btrim(e ->> 'name'),
    nullif(btrim(coalesce(e ->> 'url', '')), ''),
    nullif(btrim(coalesce(e ->> 'user', '')), ''),
    nullif(btrim(coalesce(e ->> 'uid', '')), '')
  from jsonb_array_elements(p_providers) as e
  where length(btrim(coalesce(e ->> 'name', ''))) > 0
  on conflict (id) do update set
    name     = excluded.name,
    url      = excluded.url,
    username = excluded.username,
    uid      = excluded.uid
  where p.user_id = v_uid;

  return query
    select * from public.providers p where p.user_id = v_uid order by p.name;
end;
$$;

revoke all on function public.sync_domains(jsonb)   from public, anon;
revoke all on function public.sync_providers(jsonb) from public, anon;
grant execute on function public.sync_domains(jsonb)   to authenticated;
grant execute on function public.sync_providers(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Housekeeping: drop expired cache and stale rate-limit windows.
-- ---------------------------------------------------------------------------
create or replace function public.purge_transient()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.lookup_cache where expires_at < now();
  delete from public.rate_limits  where window_start < now() - interval '1 day';
$$;

-- ---------------------------------------------------------------------------
-- consume_rate_limit — atomic fixed-window counter.
--
-- Done in SQL rather than in the Edge Function because a read-then-write from
-- the application layer races under concurrency and silently lets bursts
-- through. Returns true if the call is allowed.
-- ---------------------------------------------------------------------------
create or replace function public.consume_rate_limit(
  p_bucket         text,
  p_limit          integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window timestamptz;
  v_count  integer;
begin
  v_window := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.rate_limits as rl (bucket, window_start, count)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start)
    do update set count = rl.count + 1
  returning rl.count into v_count;

  return v_count <= p_limit;
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
