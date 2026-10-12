-- ============================================================================
-- Domain Vault — public status page (getdomainvault.com/status)
--
-- Every 5 minutes the status function probes each part of the service and
-- records one row per part here. The page shows, per part, 90 daily blocks
-- (all checks passed / some failed / most failed) and the uptime over those
-- days, plus the current state from the latest checks.
-- ============================================================================

create table if not exists public.status_checks (
  id         bigint generated always as identity primary key,
  component  text not null,
  ok         boolean not null,
  latency_ms integer,
  detail     text,
  checked_at timestamptz not null default now(),
  constraint status_checks_component_shape check (component ~ '^[a-z0-9-]{2,40}$'),
  constraint status_checks_detail_len check (detail is null or length(detail) <= 300)
);

create index if not exists status_checks_time_idx on public.status_checks (checked_at);
create index if not exists status_checks_component_idx on public.status_checks (component, checked_at desc);

alter table public.status_checks enable row level security;
revoke all on public.status_checks from anon, authenticated;

-- Checks per part and day (UTC), for the page's 90 blocks.
create or replace function public.status_daily(p_days integer)
returns table (component text, day date, total integer, ok integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select component, (checked_at at time zone 'utc')::date, count(*)::integer, count(*) filter (where ok)::integer
    from public.status_checks
   where checked_at >= (now() at time zone 'utc')::date - greatest(p_days - 1, 0)
   group by 1, 2;
$$;

-- When each scheduled job last ran, and how (null where pg_cron is absent).
create or replace function public.status_job_health()
returns table (jobname text, last_run timestamptz, last_status text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'cron') then
    return;
  end if;
  return query execute $q$
    select j.jobname::text, d.start_time, d.status::text
      from cron.job j
      left join lateral (
        select start_time, status from cron.job_run_details r
         where r.jobid = j.jobid order by start_time desc limit 1
      ) d on true
     where j.jobname like 'domain-vault-%'
  $q$;
end;
$$;

revoke all on function public.status_daily(integer) from public, anon, authenticated;
revoke all on function public.status_job_health() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net')
     or not exists (select 1 from pg_namespace where nspname = 'vault') then
    raise notice 'pg_cron, pg_net or vault unavailable; run the status probe externally.';
    return;
  end if;

  perform cron.unschedule(jobid) from cron.job where jobname = 'domain-vault-status';

  perform cron.schedule(
    'domain-vault-status',
    '*/5 * * * *',
    $job$
      select net.http_post(
        url     := (select decrypted_secret from vault.decrypted_secrets
                     where name = 'dv_functions_base_url') || '/status',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                             where name = 'dv_cron_secret')
        ),
        body    := '{"action":"probe"}'::jsonb,
        timeout_milliseconds := 30000
      )
      where exists (select 1 from vault.decrypted_secrets where name = 'dv_functions_base_url')
        and exists (select 1 from vault.decrypted_secrets where name = 'dv_cron_secret');
    $job$
  );
end $$;
