-- ============================================================================
-- Domain Vault — core schema
-- Replaces the Google Sheets backend (Users/Domains/Providers/Settings/
-- Notifications tabs) with real tables owned by Supabase Auth users.
--
-- Design notes:
--   * Passwords are NEVER stored here. Authentication is delegated to
--     Supabase Auth (auth.users), which stores bcrypt hashes.
--   * Registrar credentials are stored as AES-256-GCM ciphertext only. The
--     encryption key lives in Edge Function env, never in the database, so a
--     database dump alone does not reveal any registrar password.
--   * Every user-owned table carries user_id and is protected by RLS
--     (see 20260912000200_rls.sql).
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.account_status as enum ('pending', 'active', 'suspended');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.plan_tier as enum ('Personal', 'Start-up', 'Business', 'Agency');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles — one row per auth user
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  phone       text,
  location    text,
  status      public.account_status not null default 'pending',
  plan        public.plan_tier      not null default 'Personal',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists profiles_email_idx on public.profiles (lower(email));

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- plan_limits — server-side source of truth for entitlements.
-- The frontend's PLAN_LIMITS object is a display convenience only; it is
-- trivially editable in devtools, so the real limit is enforced in the DB.
-- domain_limit null == unlimited.
-- ---------------------------------------------------------------------------
create table if not exists public.plan_limits (
  plan         public.plan_tier primary key,
  domain_limit integer
);

insert into public.plan_limits (plan, domain_limit) values
  ('Personal',  5),
  ('Start-up', 20),
  ('Business', 50),
  ('Agency',   null)
on conflict (plan) do update set domain_limit = excluded.domain_limit;

-- ---------------------------------------------------------------------------
-- providers — registrar accounts. Non-secret fields only; the optional
-- password lives in provider_secrets, which no client role can read.
-- ---------------------------------------------------------------------------
create table if not exists public.providers (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  name              text not null,
  url               text,
  username          text,
  uid               text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint providers_name_not_blank check (length(btrim(name)) > 0)
);

create unique index if not exists providers_user_name_uniq
  on public.providers (user_id, lower(name));
create index if not exists providers_user_idx on public.providers (user_id);

drop trigger if exists providers_set_updated_at on public.providers;
create trigger providers_set_updated_at
  before update on public.providers
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- provider_secrets — AES-256-GCM ciphertext for registrar passwords.
--
-- Deliberately a separate table: RLS is enabled with NO policies, so neither
-- the anon nor the authenticated role can read it under any query, including
-- an accidental "select *" on a joined view. Only the service role, used by
-- the api Edge Function after it has verified ownership, can reach it.
--
-- The decryption key is never in this database. Losing a DB dump therefore
-- does not lose any registrar password.
--
-- Storing these at all is opt-in per provider; see SECURITY.md.
-- ---------------------------------------------------------------------------
create table if not exists public.provider_secrets (
  provider_id uuid primary key references public.providers (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  ciphertext  text not null,
  iv          text not null,
  key_version integer not null default 1,
  set_at      timestamptz not null default now()
);

create index if not exists provider_secrets_user_idx on public.provider_secrets (user_id);

-- ---------------------------------------------------------------------------
-- domains
-- ---------------------------------------------------------------------------
create table if not exists public.domains (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  name           text not null,
  provider_name  text,
  purchase_date  date,
  renewal_date   date,
  purchase_price numeric(12,2) not null default 0,
  renewal_price  numeric(12,2) not null default 0,
  auto_renew     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint domains_name_not_blank check (length(btrim(name)) > 0),
  constraint domains_prices_non_negative check (purchase_price >= 0 and renewal_price >= 0)
);

create unique index if not exists domains_user_name_uniq
  on public.domains (user_id, lower(name));
create index if not exists domains_user_idx on public.domains (user_id);
-- Supports the daily reminder sweep, which scans by renewal date.
create index if not exists domains_renewal_idx on public.domains (renewal_date)
  where renewal_date is not null;

drop trigger if exists domains_set_updated_at on public.domains;
create trigger domains_set_updated_at
  before update on public.domains
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- settings — one row per user
-- profile_pic_url points at Supabase Storage. The old backend inlined a
-- base64 data URL into the sheet cell; that is megabytes per row and is
-- migrated to Storage by web/api.js on first save.
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  theme           text not null default 'dark',
  language        text not null default 'en',
  username        text,
  profile_pic_url text,
  updated_at      timestamptz not null default now()
);

drop trigger if exists settings_set_updated_at on public.settings;
create trigger settings_set_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- notifications — renewal reminders already delivered.
-- The unique index is what makes the daily cron idempotent: re-running it
-- cannot send the same 30/7/1-day reminder for the same domain twice.
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  domain_id   uuid references public.domains (id) on delete cascade,
  domain_name text not null,
  diff_days   integer not null,
  type        text not null default 'renewal',
  channel     text not null default 'email',
  read        boolean not null default false,
  created_at  timestamptz not null default now()
);

create unique index if not exists notifications_dedupe_uniq
  on public.notifications (domain_id, diff_days, type, channel)
  where domain_id is not null;
create index if not exists notifications_user_idx
  on public.notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- webhook_events — payment webhook idempotency + audit trail.
-- Every accepted webhook is recorded by its provider-side id, so a replayed
-- IPN cannot upgrade a plan twice.
-- ---------------------------------------------------------------------------
create table if not exists public.webhook_events (
  id           text primary key,
  provider     text not null,
  event_type   text,
  user_email   text,
  payload      jsonb,
  processed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- credential_access_log — who revealed which registrar password, and when.
-- ---------------------------------------------------------------------------
create table if not exists public.credential_access_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  provider_id uuid,
  action      text not null,
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index if not exists credential_access_user_idx
  on public.credential_access_log (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- lookup_cache — WHOIS/DNS responses, so we do not hammer upstream APIs.
-- ---------------------------------------------------------------------------
create table if not exists public.lookup_cache (
  key        text primary key,
  payload    jsonb not null,
  expires_at timestamptz not null
);

create index if not exists lookup_cache_expiry_idx on public.lookup_cache (expires_at);

-- ---------------------------------------------------------------------------
-- rate_limits — fixed-window counters keyed by "<user or ip>:<route>".
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (bucket, window_start)
);
