-- ============================================================================
-- Domain Vault — Row Level Security
--
-- This file is the fix for the central flaw in the Apps Script backend, where
-- the caller supplied their own email address and the server simply believed
-- it. Here, identity comes from a signed JWT via auth.uid() and the database
-- itself refuses to return another user's rows, regardless of what the
-- application layer asks for.
--
-- Tables with RLS enabled and NO policies (provider_secrets, lookup_cache,
-- rate_limits, webhook_events) are unreachable by the anon and authenticated
-- roles entirely. Only the service role touches them.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- account_is_active — used inside the data policies below so that a pending
-- or suspended account is locked out by the database itself, not merely by
-- application code. SECURITY DEFINER because the caller cannot be allowed to
-- read profiles before this check has passed.
--
-- Failure mode is deliberately "locked out", never "open": a user with no
-- profile row gets false.
-- ---------------------------------------------------------------------------
create or replace function public.account_is_active()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.status = 'active'
  );
$$;

revoke all on function public.account_is_active() from public, anon;
grant execute on function public.account_is_active() to authenticated;

alter table public.profiles              enable row level security;
alter table public.providers             enable row level security;
alter table public.provider_secrets      enable row level security;
alter table public.domains               enable row level security;
alter table public.settings              enable row level security;
alter table public.notifications         enable row level security;
alter table public.plan_limits           enable row level security;
alter table public.webhook_events        enable row level security;
alter table public.credential_access_log enable row level security;
alter table public.lookup_cache          enable row level security;
alter table public.rate_limits           enable row level security;

-- ---------------------------------------------------------------------------
-- profiles — read and update your own only.
-- There is deliberately no INSERT policy: profiles are created by the
-- handle_new_user trigger. There is no DELETE policy: account deletion goes
-- through auth.users and cascades.
-- Plan and status are protected against self-service escalation by the
-- guard_profile_privileges trigger in the next migration.
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- providers
-- ---------------------------------------------------------------------------
drop policy if exists providers_select_own on public.providers;
create policy providers_select_own on public.providers
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.account_is_active()));

drop policy if exists providers_insert_own on public.providers;
create policy providers_insert_own on public.providers
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.account_is_active()));

drop policy if exists providers_update_own on public.providers;
create policy providers_update_own on public.providers
  for update to authenticated
  using (user_id = (select auth.uid()) and (select public.account_is_active()))
  with check (user_id = (select auth.uid()) and (select public.account_is_active()));

drop policy if exists providers_delete_own on public.providers;
create policy providers_delete_own on public.providers
  for delete to authenticated
  using (user_id = (select auth.uid()) and (select public.account_is_active()));

-- ---------------------------------------------------------------------------
-- domains
-- ---------------------------------------------------------------------------
drop policy if exists domains_select_own on public.domains;
create policy domains_select_own on public.domains
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.account_is_active()));

drop policy if exists domains_insert_own on public.domains;
create policy domains_insert_own on public.domains
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.account_is_active()));

drop policy if exists domains_update_own on public.domains;
create policy domains_update_own on public.domains
  for update to authenticated
  using (user_id = (select auth.uid()) and (select public.account_is_active()))
  with check (user_id = (select auth.uid()) and (select public.account_is_active()));

drop policy if exists domains_delete_own on public.domains;
create policy domains_delete_own on public.domains
  for delete to authenticated
  using (user_id = (select auth.uid()) and (select public.account_is_active()));

-- ---------------------------------------------------------------------------
-- settings
-- ---------------------------------------------------------------------------
drop policy if exists settings_select_own on public.settings;
create policy settings_select_own on public.settings
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.account_is_active()));

drop policy if exists settings_insert_own on public.settings;
create policy settings_insert_own on public.settings
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.account_is_active()));

drop policy if exists settings_update_own on public.settings;
create policy settings_update_own on public.settings
  for update to authenticated
  using (user_id = (select auth.uid()) and (select public.account_is_active()))
  with check (user_id = (select auth.uid()) and (select public.account_is_active()));

-- ---------------------------------------------------------------------------
-- notifications — users may read their own and mark them read. Rows are
-- created by the reminders job running as the service role.
-- ---------------------------------------------------------------------------
drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists notifications_delete_own on public.notifications;
create policy notifications_delete_own on public.notifications
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- credential_access_log — a user can read their own access history but can
-- never modify or delete it; only the service role writes entries.
-- ---------------------------------------------------------------------------
drop policy if exists credential_access_select_own on public.credential_access_log;
create policy credential_access_select_own on public.credential_access_log
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- plan_limits — public reference data, readable by any signed-in user.
-- ---------------------------------------------------------------------------
drop policy if exists plan_limits_read on public.plan_limits;
create policy plan_limits_read on public.plan_limits
  for select to authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- Least-privilege grants.
--
-- Supabase grants broad table privileges to anon/authenticated by default.
-- RLS already constrains rows, but there is no reason for the anon role to
-- hold any privilege on application tables at all.
-- ---------------------------------------------------------------------------
revoke all on public.profiles, public.providers, public.provider_secrets,
              public.domains, public.settings, public.notifications,
              public.webhook_events, public.credential_access_log,
              public.lookup_cache, public.rate_limits
  from anon;

revoke all on public.provider_secrets, public.webhook_events,
              public.lookup_cache, public.rate_limits
  from authenticated;

-- The log is append-only from the application's perspective.
revoke insert, update, delete on public.credential_access_log from authenticated;
revoke insert, update, delete on public.plan_limits from authenticated, anon;
