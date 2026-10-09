-- ============================================================================
-- Domain Vault — team accounts
--
-- Customer feedback: Business and Agency customers have staff. An account
-- owner can now invite people into their vault and choose, per person, what
-- they may do. With nothing ticked a member can only look.
--
--   * A vault is still the set of rows owned by one account (user_id). A
--     membership (team_members) lets another account reach those rows.
--   * Every rule on domains and providers now reads "your own rows, or rows
--     of a vault you belong to, within the permissions you were given". The
--     database enforces it; hidden buttons in the app are only a courtesy.
--   * Seats per plan (owner included): Personal 1, Start-up 2, Business 5,
--     Agency unlimited. No extra seats are sold — customers upgrade. When an
--     owner's plan shrinks (a lapsed subscription, say), only the members
--     that still fit keep access, oldest first, so a team cannot be kept by
--     buying a big plan once.
--   * One person can belong to several teams.
--   * Invitations are links emailed to the invitee (256-bit token, 7 days).
--     Holding the link proves the inbox; the accepting account's own email
--     is not trusted, since sign-up emails are not verified.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Seats
-- ---------------------------------------------------------------------------
alter table public.plan_limits add column if not exists seat_limit integer;
update public.plan_limits set seat_limit = case plan
  when 'Free' then 1 when 'Personal' then 1 when 'Start-up' then 2 when 'Business' then 5
  else null end;   -- Agency: unlimited
comment on column public.plan_limits.seat_limit is 'People per vault, owner included; null = unlimited.';

-- ---------------------------------------------------------------------------
-- Members and their permissions
-- ---------------------------------------------------------------------------
create table if not exists public.team_members (
  owner_id           uuid not null references auth.users (id) on delete cascade,
  member_id          uuid not null references auth.users (id) on delete cascade,
  can_edit_domains   boolean not null default false,
  can_edit_providers boolean not null default false,
  can_delete         boolean not null default false,
  can_export         boolean not null default false,
  can_see_passwords  boolean not null default false,
  can_manage_team    boolean not null default false,
  gets_reminders     boolean not null default false,
  invited_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (owner_id, member_id),
  constraint team_members_not_self check (owner_id <> member_id)
);

create index if not exists team_members_member_idx on public.team_members (member_id);

drop trigger if exists team_members_set_updated_at on public.team_members;
create trigger team_members_set_updated_at
  before update on public.team_members
  for each row execute function public.set_updated_at();

create table if not exists public.team_invitations (
  token              text primary key,
  owner_id           uuid not null references auth.users (id) on delete cascade,
  email              text not null,
  can_edit_domains   boolean not null default false,
  can_edit_providers boolean not null default false,
  can_delete         boolean not null default false,
  can_export         boolean not null default false,
  can_see_passwords  boolean not null default false,
  can_manage_team    boolean not null default false,
  gets_reminders     boolean not null default false,
  invited_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null default now() + interval '7 days',
  accepted_at        timestamptz,
  accepted_by        uuid references auth.users (id) on delete set null,
  constraint team_invitations_token_shape check (token ~ '^[A-Za-z0-9_-]{43}$')
);

create index if not exists team_invitations_owner_idx on public.team_invitations (owner_id, lower(email));

-- ---------------------------------------------------------------------------
-- Activity log: who changed what in a vault.
-- ---------------------------------------------------------------------------
create table if not exists public.vault_activity (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  actor_id    uuid references auth.users (id) on delete set null,
  actor_email text,
  action      text not null,
  target      text,
  details     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create index if not exists vault_activity_owner_idx on public.vault_activity (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- member_can — the single permission check.
--
--   member_can(owner, user, perm) is true when user IS the owner (and their
--   account is active), or user is a member of owner's vault who still fits
--   the owner's seats, both accounts are active, and the member holds perm.
--   'view' needs membership only.
-- ---------------------------------------------------------------------------
create or replace function public.member_can(p_owner uuid, p_member uuid, p_perm text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_owner is null or p_member is null then false
    when p_owner = p_member then exists (
      select 1 from public.profiles where id = p_owner and status = 'active')
    else exists (
      select 1
        from public.team_members m
        join public.profiles o  on o.id = m.owner_id  and o.status = 'active'
        join public.profiles mp on mp.id = m.member_id and mp.status = 'active'
        join public.plan_limits pl on pl.plan = o.plan
       where m.owner_id = p_owner and m.member_id = p_member
         -- seat position: the owner takes one seat, members fill the rest by age
         and (pl.seat_limit is null or (
               select count(*) from public.team_members e
                where e.owner_id = m.owner_id
                  and (e.created_at, e.member_id) <= (m.created_at, m.member_id)
             ) <= pl.seat_limit - 1)
         and case p_perm
               when 'view'           then true
               when 'edit_domains'   then m.can_edit_domains
               when 'edit_providers' then m.can_edit_providers
               when 'delete'         then m.can_delete
               when 'export'         then m.can_export
               when 'passwords'      then m.can_see_passwords
               when 'manage'         then m.can_manage_team
               else false
             end)
  end;
$$;

revoke all on function public.member_can(uuid, uuid, text) from public, anon, authenticated;

-- The same check for the signed-in user, for row level security.
create or replace function public.vault_can(p_owner uuid, p_perm text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.member_can(p_owner, auth.uid(), p_perm);
$$;

revoke all on function public.vault_can(uuid, text) from public, anon;
grant execute on function public.vault_can(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security: own rows, or a vault you belong to, by permission.
-- (Own rows are checked first and cheaply; the membership check only runs
-- for rows of other vaults.)
-- ---------------------------------------------------------------------------
drop policy if exists domains_select_own on public.domains;
drop policy if exists domains_insert_own on public.domains;
drop policy if exists domains_update_own on public.domains;
drop policy if exists domains_delete_own on public.domains;
drop policy if exists domains_select_team on public.domains;
drop policy if exists domains_insert_team on public.domains;
drop policy if exists domains_update_team on public.domains;
drop policy if exists domains_delete_team on public.domains;

create policy domains_select_team on public.domains for select to authenticated
  using ((user_id = (select auth.uid()) and (select public.account_is_active()))
         or public.vault_can(user_id, 'view'));
create policy domains_insert_team on public.domains for insert to authenticated
  with check ((user_id = (select auth.uid()) and (select public.account_is_active()))
              or public.vault_can(user_id, 'edit_domains'));
create policy domains_update_team on public.domains for update to authenticated
  using ((user_id = (select auth.uid()) and (select public.account_is_active()))
         or public.vault_can(user_id, 'edit_domains'))
  with check ((user_id = (select auth.uid()) and (select public.account_is_active()))
              or public.vault_can(user_id, 'edit_domains'));
create policy domains_delete_team on public.domains for delete to authenticated
  using ((user_id = (select auth.uid()) and (select public.account_is_active()))
         or public.vault_can(user_id, 'delete'));

drop policy if exists providers_select_own on public.providers;
drop policy if exists providers_insert_own on public.providers;
drop policy if exists providers_update_own on public.providers;
drop policy if exists providers_delete_own on public.providers;
drop policy if exists providers_select_team on public.providers;
drop policy if exists providers_insert_team on public.providers;
drop policy if exists providers_update_team on public.providers;
drop policy if exists providers_delete_team on public.providers;

create policy providers_select_team on public.providers for select to authenticated
  using ((user_id = (select auth.uid()) and (select public.account_is_active()))
         or public.vault_can(user_id, 'view'));
create policy providers_insert_team on public.providers for insert to authenticated
  with check ((user_id = (select auth.uid()) and (select public.account_is_active()))
              or public.vault_can(user_id, 'edit_providers'));
create policy providers_update_team on public.providers for update to authenticated
  using ((user_id = (select auth.uid()) and (select public.account_is_active()))
         or public.vault_can(user_id, 'edit_providers'))
  with check ((user_id = (select auth.uid()) and (select public.account_is_active()))
              or public.vault_can(user_id, 'edit_providers'));
create policy providers_delete_team on public.providers for delete to authenticated
  using ((user_id = (select auth.uid()) and (select public.account_is_active()))
         or public.vault_can(user_id, 'delete'));

-- Team tables: members see their own memberships, owners and team managers
-- see their team; all writes go through the api function (service role).
alter table public.team_members enable row level security;
alter table public.team_invitations enable row level security;
alter table public.vault_activity enable row level security;

drop policy if exists team_members_read on public.team_members;
create policy team_members_read on public.team_members for select to authenticated
  using (member_id = (select auth.uid()) or public.vault_can(owner_id, 'manage'));

drop policy if exists vault_activity_read on public.vault_activity;
create policy vault_activity_read on public.vault_activity for select to authenticated
  using (public.vault_can(owner_id, 'manage'));

revoke all on public.team_members, public.team_invitations, public.vault_activity from anon;
revoke insert, update, delete on public.team_members, public.vault_activity from authenticated;
revoke all on public.team_invitations from authenticated;
grant select on public.team_members, public.vault_activity to authenticated;

-- ---------------------------------------------------------------------------
-- team_seats — people in a vault (owner + members + open invitations) and
-- the plan's limit.
-- ---------------------------------------------------------------------------
create or replace function public.team_seats(p_owner uuid)
returns table (used integer, seat_limit integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (1
          + (select count(*) from public.team_members where owner_id = p_owner)
          + (select count(*) from public.team_invitations
              where owner_id = p_owner and accepted_at is null and expires_at > now()))::integer,
         (select pl.seat_limit from public.profiles p join public.plan_limits pl on pl.plan = p.plan
           where p.id = p_owner);
$$;

revoke all on function public.team_seats(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- team_invite — record an invitation, if the actor may and a seat is free.
-- A new invitation to the same email replaces the open one (resend).
-- ---------------------------------------------------------------------------
create or replace function public.team_invite(
  p_owner uuid, p_actor uuid, p_email text, p_token text, p_perms jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(btrim(p_email));
  v_used  integer;
  v_limit integer;
begin
  if not public.member_can(p_owner, p_actor, 'manage') then
    raise exception 'you cannot manage this team' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where id = p_owner and lower(email) = v_email) then
    raise exception 'the owner is already in this vault' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.team_members m join public.profiles p on p.id = m.member_id
              where m.owner_id = p_owner and lower(p.email) = v_email) then
    raise exception 'this person is already in the team' using errcode = 'P0001';
  end if;

  delete from public.team_invitations
   where owner_id = p_owner and lower(email) = v_email and accepted_at is null;

  select used, seat_limit into v_used, v_limit from public.team_seats(p_owner);
  if v_limit is not null and v_used >= v_limit then
    raise exception 'seat limit reached (% of %)', v_used, v_limit using errcode = 'P0003';
  end if;

  insert into public.team_invitations (token, owner_id, email, invited_by,
    can_edit_domains, can_edit_providers, can_delete, can_export, can_see_passwords, can_manage_team, gets_reminders)
  values (p_token, p_owner, v_email, p_actor,
    coalesce((p_perms->>'editDomains')::boolean, false),
    coalesce((p_perms->>'editProviders')::boolean, false),
    coalesce((p_perms->>'delete')::boolean, false),
    coalesce((p_perms->>'export')::boolean, false),
    coalesce((p_perms->>'passwords')::boolean, false),
    coalesce((p_perms->>'manage')::boolean, false),
    coalesce((p_perms->>'reminders')::boolean, false));
end;
$$;

revoke all on function public.team_invite(uuid, uuid, text, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- team_accept — turn an invitation into a membership. Returns the owner.
-- Accepting also activates a pending account: a paying owner vouched for
-- this person.
-- ---------------------------------------------------------------------------
create or replace function public.team_accept(p_token text, p_user uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv   public.team_invitations%rowtype;
  v_used  integer;
  v_limit integer;
begin
  select * into v_inv from public.team_invitations where token = p_token for update;
  if not found or v_inv.accepted_at is not null or v_inv.expires_at <= now() then
    raise exception 'invitation is invalid, already used or expired' using errcode = 'P0002';
  end if;
  if v_inv.owner_id = p_user then
    raise exception 'you cannot join your own vault' using errcode = 'P0001';
  end if;

  -- Seats are checked again: the plan may have changed since the invite.
  -- This invitation already holds a seat in team_seats, so "used" counts it.
  select used, seat_limit into v_used, v_limit from public.team_seats(v_inv.owner_id);
  if v_limit is not null and v_used > v_limit then
    raise exception 'seat limit reached (% of %)', v_used, v_limit using errcode = 'P0003';
  end if;

  insert into public.team_members (owner_id, member_id, invited_by,
    can_edit_domains, can_edit_providers, can_delete, can_export, can_see_passwords, can_manage_team, gets_reminders)
  values (v_inv.owner_id, p_user, v_inv.invited_by,
    v_inv.can_edit_domains, v_inv.can_edit_providers, v_inv.can_delete, v_inv.can_export,
    v_inv.can_see_passwords, v_inv.can_manage_team, v_inv.gets_reminders)
  on conflict (owner_id, member_id) do update set
    can_edit_domains = excluded.can_edit_domains, can_edit_providers = excluded.can_edit_providers,
    can_delete = excluded.can_delete, can_export = excluded.can_export,
    can_see_passwords = excluded.can_see_passwords, can_manage_team = excluded.can_manage_team,
    gets_reminders = excluded.gets_reminders;

  update public.team_invitations set accepted_at = now(), accepted_by = p_user where token = p_token;
  update public.profiles set status = 'active' where id = p_user and status = 'pending';
  return v_inv.owner_id;
end;
$$;

revoke all on function public.team_accept(text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- team_reminder_recipients — members who get the owner's renewal digest.
-- ---------------------------------------------------------------------------
create or replace function public.team_reminder_recipients(p_owner uuid)
returns table (member_id uuid, email text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.member_id, p.email
    from public.team_members m
    join public.profiles p on p.id = m.member_id
   where m.owner_id = p_owner
     and m.gets_reminders
     and public.member_can(p_owner, m.member_id, 'view');
$$;

revoke all on function public.team_reminder_recipients(uuid) from public, anon, authenticated;
