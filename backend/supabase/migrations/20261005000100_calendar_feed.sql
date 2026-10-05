-- ============================================================================
-- Domain Vault — calendar subscription feed
--
-- "Sync to Google" used to say "coming soon". Pushing events into a user's
-- Google Calendar would need OAuth and a Google Cloud app; a subscription
-- feed needs neither and works with Google, Apple and Outlook alike. The
-- calendar app polls a private URL and always shows the current renewal
-- dates, so a renewed domain moves by itself.
--
-- The URL carries a random token; whoever has it can read that user's renewal
-- dates (domain, provider, price), nothing else. The user can replace the
-- token at any time, which kills the old URL.
--
-- The token is stored as-is, not hashed. Everything the feed reveals is
-- already in this database, so a dump of this table exposes nothing a dump of
-- `domains` would not — and storing it lets the user copy the link again
-- later instead of having to reset it.
-- ============================================================================

create table if not exists public.calendar_feeds (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  token      text not null unique,
  created_at timestamptz not null default now(),
  constraint calendar_feeds_token_shape check (token ~ '^[A-Za-z0-9_-]{43}$')
);

-- No policies: only the api and calendar functions (service role) touch it.
alter table public.calendar_feeds enable row level security;
revoke all on public.calendar_feeds from anon, authenticated;

-- ---------------------------------------------------------------------------
-- calendar_feed — the rows one feed shows.
--
-- Nothing for an unknown token, and nothing for an account that is not
-- active: suspending someone stops their feed along with everything else.
-- ---------------------------------------------------------------------------
create or replace function public.calendar_feed(p_token text)
returns table (
  domain_id     uuid,
  domain_name   text,
  provider_name text,
  renewal_date  date,
  renewal_price numeric,
  auto_renew    boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.name, d.provider_name, d.renewal_date, d.renewal_price, d.auto_renew
    from public.calendar_feeds f
    join public.profiles p on p.id = f.user_id and p.status = 'active'
    join public.domains  d on d.user_id = f.user_id
   where f.token = p_token
     and d.renewal_date is not null
   order by d.renewal_date, d.name;
$$;

revoke all on function public.calendar_feed(text) from public, anon, authenticated;
grant execute on function public.calendar_feed(text) to service_role;
