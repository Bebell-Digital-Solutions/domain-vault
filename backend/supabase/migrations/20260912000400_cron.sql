-- ============================================================================
-- Domain Vault — scheduled jobs
--
-- Replaces the Apps Script time-driven trigger that ran checkRenewalsAndNotify.
--
-- Everything here is wrapped so the migration still applies cleanly on a
-- project where pg_cron / pg_net are not enabled (local dev, or Neon). In that
-- case, schedule the reminders function with any external scheduler instead —
-- it is an ordinary authenticated HTTP endpoint. See README.md.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron unavailable; schedule the reminders function externally.';
    return;
  end if;

  create extension if not exists pg_cron;
  create extension if not exists pg_net;

  -- Daily renewal sweep at 08:00 UTC. The reminders function is itself
  -- idempotent (notifications_dedupe_uniq), so an accidental double-run
  -- cannot double-send.
  perform cron.unschedule('domain-vault-reminders')
    where exists (select 1 from cron.job where jobname = 'domain-vault-reminders');

  perform cron.schedule(
    'domain-vault-reminders',
    '0 8 * * *',
    $job$
      select net.http_post(
        url     := current_setting('app.functions_base_url', true) || '/reminders',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || current_setting('app.service_role_key', true)
        ),
        body    := '{}'::jsonb
      );
    $job$
  );

  -- Nightly cleanup of expired lookup cache and old rate-limit windows.
  perform cron.unschedule('domain-vault-purge')
    where exists (select 1 from cron.job where jobname = 'domain-vault-purge');

  perform cron.schedule(
    'domain-vault-purge',
    '30 3 * * *',
    $job$ select public.purge_transient(); $job$
  );
end $$;
