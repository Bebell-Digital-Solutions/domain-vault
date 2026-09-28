-- ============================================================================
-- Domain Vault — renewal reminders, properly
--
-- The first version matched renewal_date to exactly today+30/7/1 and keyed
-- "already sent" on (domain, days, channel). Three things went wrong:
--
--   1. Exact-date matching. A domain added 20 days before its renewal never
--      got the 30-day reminder, and any day the sweep did not run (outage,
--      failed send, project paused) lost that milestone for good.
--   2. No renewal date in the dedupe key. Once a customer renewed a domain
--      and moved its date on a year, the old rows suppressed every reminder
--      of the next cycle. Reminders worked once per domain, ever.
--   3. Nothing on the expiry day itself, and one email per domain — ten
--      domains renewing together meant ten emails.
--
-- Now: a reminder fires for the most urgent milestone a domain has CROSSED
-- and not yet been told about, the dedupe key includes the renewal date, and
-- the sweep sends one digest per user.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Per-user preferences. Sending mail people cannot switch off is not on.
-- ---------------------------------------------------------------------------
alter table public.settings
  add column if not exists reminders_enabled  boolean not null default true,
  add column if not exists reminder_channels  text[]  not null default array['email'],
  add column if not exists reminder_lead_days integer[] not null default array[30, 7, 1, 0];

alter table public.settings drop constraint if exists settings_channels_valid;
alter table public.settings add constraint settings_channels_valid
  check (reminder_channels <@ array['email', 'whatsapp']);

alter table public.settings drop constraint if exists settings_lead_days_valid;
alter table public.settings add constraint settings_lead_days_valid
  check (
    array_length(reminder_lead_days, 1) between 1 and 6
    and reminder_lead_days <@ array[0, 1, 3, 7, 14, 30, 60, 90]
  );

-- ---------------------------------------------------------------------------
-- notifications: remember which renewal cycle a reminder belonged to.
-- ---------------------------------------------------------------------------
alter table public.notifications
  add column if not exists renewal_date date;

-- Existing rows predate the column; reconstruct from the domain so the new
-- index does not collapse them together.
update public.notifications n
   set renewal_date = d.renewal_date
  from public.domains d
 where d.id = n.domain_id and n.renewal_date is null;

drop index if exists public.notifications_dedupe_uniq;
create unique index if not exists notifications_dedupe_uniq
  on public.notifications (domain_id, renewal_date, diff_days, type, channel)
  where domain_id is not null;

-- ---------------------------------------------------------------------------
-- due_reminders — everything the sweep needs to decide, in one query.
--
-- For each domain of an active user who wants reminders, the milestone is the
-- SMALLEST configured lead day that the domain has already reached
-- (lead_day >= days_left) and that the user has not been told about for this
-- renewal date. Smallest = most urgent, so a domain that appears late, or
-- after days without a sweep, produces exactly one reminder rather than a
-- backlog of them.
--
-- Expired domains are left alone: nagging after the fact helps nobody, and
-- the dashboard already shows them as expired.
-- ---------------------------------------------------------------------------
create or replace function public.due_reminders(
  p_today   date default current_date,
  p_channel text default 'email'
)
returns table (
  user_id      uuid,
  email        text,
  phone        text,
  domain_id    uuid,
  domain_name  text,
  renewal_date date,
  renewal_price numeric,
  auto_renew   boolean,
  provider_name text,
  days_left    integer,
  milestone    integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id, p.email, p.phone,
    d.id, d.name, d.renewal_date, d.renewal_price, d.auto_renew, d.provider_name,
    (d.renewal_date - p_today)::int as days_left,
    m.milestone
  from public.domains d
  join public.profiles p on p.id = d.user_id and p.status = 'active'
  left join public.settings s on s.user_id = d.user_id
  -- The most urgent milestone this domain has reached. Computed WITHOUT
  -- reference to what was already sent: taking the smallest un-sent lead
  -- instead would walk backwards, following a "7 days left" reminder with a
  -- "30 days left" one the next day.
  cross join lateral (
    select min(lead) as milestone
    from unnest(coalesce(s.reminder_lead_days, array[30, 7, 1, 0])) as lead
    where lead >= (d.renewal_date - p_today)
  ) m
  where d.renewal_date is not null
    and d.renewal_date >= p_today                    -- not already expired
    and coalesce(s.reminders_enabled, true)
    and p_channel = any (coalesce(s.reminder_channels, array['email']))
    and (p_channel <> 'whatsapp' or nullif(btrim(coalesce(p.phone, '')), '') is not null)
    and m.milestone is not null
    -- ...and they have not already been told about this one, for this cycle.
    and not exists (
      select 1 from public.notifications n
      where n.domain_id    = d.id
        and n.renewal_date = d.renewal_date
        and n.diff_days    = m.milestone
        and n.type         = 'renewal'
        and n.channel      = p_channel
    )
  order by p.id, d.renewal_date, d.name;
$$;

revoke all on function public.due_reminders(date, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Retention: sent reminders are a log, not history worth keeping forever.
-- ---------------------------------------------------------------------------
create or replace function public.purge_transient()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.lookup_cache where expires_at < now();
  delete from public.rate_limits  where window_start < now() - interval '1 day';
  delete from public.notifications where created_at < now() - interval '180 days';
$$;
