-- ============================================================================
-- Status page: checks grouped into equal time slices.
--
-- The page always shows 90 bars. Until there are 90 days of history, each bar
-- covers a shorter slice (15 minutes, an hour, 6 hours), so every bar shown
-- is measured data; once 90 days exist, each bar is a day.
-- ============================================================================

create or replace function public.status_buckets(p_seconds integer, p_count integer)
returns table (component text, bucket integer, total integer, ok integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with bounds as (
    -- The slice that contains now is the last one.
    select to_timestamp(floor(extract(epoch from now()) / p_seconds) * p_seconds + p_seconds) as stop
  )
  select c.component,
         (p_count - 1 - floor(extract(epoch from (b.stop - c.checked_at)) / p_seconds))::integer as bucket,
         count(*)::integer,
         count(*) filter (where c.ok)::integer
    from public.status_checks c, bounds b
   where c.checked_at >= b.stop - make_interval(secs => p_seconds::double precision * p_count)
   group by 1, 2;
$$;

revoke all on function public.status_buckets(integer, integer) from public, anon, authenticated;
