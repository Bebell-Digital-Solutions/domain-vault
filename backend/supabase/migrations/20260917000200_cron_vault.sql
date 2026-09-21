-- ============================================================================
-- Domain Vault — reminder schedule, take two
--
-- The first version (20260912000400) read the functions URL and the service
-- role key from custom database settings (app.functions_base_url,
-- app.service_role_key). Those settings were never set on the hosted
-- project, so the daily job posted to a NULL url and failed silently every
-- day. It also meant storing the service role key — which bypasses every
-- security policy — as a plain database setting.
--
-- This version reads two values from Supabase Vault (encrypted at rest):
--
--   dv_functions_base_url   e.g. https://<ref>.supabase.co/functions/v1
--   dv_cron_secret          a random string, also set as the CRON_SECRET
--                           secret of the reminders function
--
-- The cron secret authorizes exactly one thing — triggering the reminder
-- sweep — so a leak is far less serious than leaking the service role key.
--
-- Create the two Vault entries once per project (SQL editor):
--
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'dv_functions_base_url');
--   select vault.create_secret('<same value as CRON_SECRET>',           'dv_cron_secret');
--
-- Until they exist, the job runs and does nothing.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net')
     or not exists (select 1 from pg_namespace where nspname = 'vault') then
    raise notice 'pg_cron, pg_net or vault unavailable; schedule the reminders function externally.';
    return;
  end if;

  perform cron.unschedule(jobid) from cron.job where jobname = 'domain-vault-reminders';

  perform cron.schedule(
    'domain-vault-reminders',
    '0 8 * * *',
    $job$
      select net.http_post(
        url     := (select decrypted_secret from vault.decrypted_secrets
                     where name = 'dv_functions_base_url') || '/reminders',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                             where name = 'dv_cron_secret')
        ),
        body    := '{}'::jsonb
      )
      where exists (select 1 from vault.decrypted_secrets where name = 'dv_functions_base_url')
        and exists (select 1 from vault.decrypted_secrets where name = 'dv_cron_secret');
    $job$
  );
end $$;
