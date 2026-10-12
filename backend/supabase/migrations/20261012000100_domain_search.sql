-- ============================================================================
-- Domain Vault — domain search: where to buy a name, and what it really costs
--
-- The public domain-search tool and the app's Domain Search page check if a
-- name is free (registry RDAP, see the domain-search function) and compare
-- registrars by first-year price, renewal price and 5-year cost
-- (first year + 4 renewals).
--
--   registrars        the companies compared, each with the link a buyer is
--                     sent to: {domain} and {tld} are filled in, so affiliate
--                     links go here (Admin → Domain search).
--   registrar_prices  price per extension and registrar, in USD. Porkbun's are
--                     refreshed daily from Porkbun's public price list
--                     (source 'porkbun'); the rest are entered by the owner
--                     (source 'manual').
--
-- Prices are public information, served by the function; no client role
-- reads these tables directly.
-- ============================================================================

create table if not exists public.registrars (
  id           text primary key,
  name         text not null,
  website      text not null,
  url_template text not null,
  whois        text not null default '',
  ssl          text not null default '',
  notes        text not null default '',
  active       boolean not null default true,
  sort         integer not null default 100,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint registrars_id_shape   check (id ~ '^[a-z0-9-]{2,40}$'),
  constraint registrars_name_len   check (length(btrim(name)) between 1 and 60),
  constraint registrars_site_shape check (website ~ '^[a-z0-9.-]{3,100}$'),
  constraint registrars_url_valid  check (url_template ~ '^https://[^\s"<>]+$' and length(url_template) <= 600),
  constraint registrars_text_len   check (length(whois) <= 60 and length(ssl) <= 60 and length(notes) <= 200)
);

create table if not exists public.registrar_prices (
  tld          text not null,
  registrar_id text not null references public.registrars (id) on delete cascade on update cascade,
  register     numeric(10,2) not null,
  renew        numeric(10,2) not null,
  currency     text not null default 'USD',
  source       text not null default 'manual',
  updated_at   timestamptz not null default now(),
  primary key (tld, registrar_id),
  constraint registrar_prices_tld_shape check (tld ~ '^[a-z0-9-]{2,63}(\.[a-z0-9-]{2,63})?$'),
  constraint registrar_prices_amounts   check (register >= 0 and renew >= 0 and register < 100000 and renew < 100000),
  constraint registrar_prices_currency  check (currency = 'USD'),
  constraint registrar_prices_source    check (source in ('manual', 'porkbun'))
);

create index if not exists registrar_prices_registrar_idx on public.registrar_prices (registrar_id);

drop trigger if exists registrars_set_updated_at on public.registrars;
create trigger registrars_set_updated_at
  before update on public.registrars
  for each row execute function public.set_updated_at();

drop trigger if exists registrar_prices_set_updated_at on public.registrar_prices;
create trigger registrar_prices_set_updated_at
  before update on public.registrar_prices
  for each row execute function public.set_updated_at();

alter table public.registrars enable row level security;
alter table public.registrar_prices enable row level security;
revoke all on public.registrars, public.registrar_prices from anon, authenticated;

-- Seed once (an empty table means "never seeded"): the owner's research from
-- the demo, with plain search links until the affiliate links are in.
insert into public.registrars (id, name, website, url_template, whois, ssl, notes, sort)
select * from (values
  ('spaceship',        'Spaceship',         'spaceship.com',        'https://www.spaceship.com/domain-search/?query={domain}',                         'Free forever', 'Paid add-on',          '', 10),
  ('cloudflare',       'Cloudflare',        'cloudflare.com',       'https://domains.cloudflare.com/?domain={domain}',                                 'Free forever', 'Free via CDN',         'Must use Cloudflare nameservers', 20),
  ('porkbun',          'Porkbun',           'porkbun.com',          'https://porkbun.com/checkout/search?q={domain}',                                  'Free forever', 'Free (Let''s Encrypt)', '', 30),
  ('namesilo',         'NameSilo',          'namesilo.com',         'https://www.namesilo.com/domain/search-domains?query={domain}',                   'Free forever', 'Paid add-on',          '', 40),
  ('namecheap',        'Namecheap',         'namecheap.com',        'https://www.namecheap.com/domains/registration/results/?domain={domain}',         'Free forever', 'Paid add-on',          '', 50),
  ('hostinger',        'Hostinger',         'hostinger.com',        'https://www.hostinger.com/domain-name-search?domain={domain}',                    'Free',         'Free',                 'Promo price needs a multi-year hosting plan', 60),
  ('ionos',            'IONOS',             'ionos.com',            'https://www.ionos.com/domains/domain-names?domain={domain}',                      'Free',         'Paid add-on',          'First-year promo price', 70),
  ('godaddy',          'GoDaddy',           'godaddy.com',          'https://www.godaddy.com/domainsearch/find?checkAvail=1&domainToCheck={domain}',   'Basic',        'Paid add-on',          '', 80),
  ('networksolutions', 'Network Solutions', 'networksolutions.com', 'https://www.networksolutions.com/domain-search/results?searchDomain={domain}',     'Paid add-on',  'Paid add-on',          'WHOIS privacy costs extra; high renewals', 90)
) as seed(id, name, website, url_template, whois, ssl, notes, sort)
where not exists (select 1 from public.registrars);

insert into public.registrar_prices (tld, registrar_id, register, renew)
select * from (values
  ('com', 'spaceship', 8.88, 10.18),
  ('com', 'cloudflare', 10.46, 10.46),
  ('com', 'porkbun', 11.08, 11.08),
  ('com', 'hostinger', 1.99, 19.99),
  ('com', 'namecheap', 11.28, 18.48),
  ('com', 'godaddy', 13.19, 23.19),
  ('com', 'ionos', 1.00, 20.00),
  ('com', 'networksolutions', 9.99, 39.99),
  ('com', 'namesilo', 10.88, 10.88),
  ('net', 'spaceship', 12.48, 13.98),
  ('net', 'cloudflare', 13.48, 13.48),
  ('net', 'porkbun', 12.98, 12.98),
  ('net', 'hostinger', 3.99, 21.99),
  ('net', 'namecheap', 13.98, 19.98),
  ('net', 'godaddy', 15.99, 24.99),
  ('net', 'ionos', 1.00, 22.00),
  ('net', 'namesilo', 13.79, 13.79),
  ('org', 'spaceship', 9.98, 11.48),
  ('org', 'cloudflare', 11.05, 11.05),
  ('org', 'porkbun', 11.54, 11.54),
  ('org', 'hostinger', 2.99, 20.99),
  ('org', 'namecheap', 12.48, 19.98),
  ('org', 'godaddy', 14.99, 23.99),
  ('org', 'ionos', 1.00, 21.00),
  ('org', 'namesilo', 11.99, 11.99),
  ('io', 'spaceship', 33.88, 38.88),
  ('io', 'cloudflare', 40.00, 40.00),
  ('io', 'porkbun', 37.84, 37.84),
  ('io', 'hostinger', 39.99, 59.99),
  ('io', 'namecheap', 42.98, 49.98),
  ('io', 'godaddy', 44.99, 69.99),
  ('io', 'ionos', 35.00, 60.00),
  ('io', 'namesilo', 39.99, 39.99),
  ('ai', 'spaceship', 79.88, 89.88),
  ('ai', 'cloudflare', 80.00, 80.00),
  ('ai', 'porkbun', 82.50, 82.50),
  ('ai', 'hostinger', 89.99, 119.99),
  ('ai', 'namecheap', 89.98, 99.98),
  ('ai', 'godaddy', 99.99, 139.99),
  ('ai', 'ionos', 80.00, 110.00),
  ('ai', 'namesilo', 84.99, 84.99),
  ('app', 'spaceship', 14.88, 17.88),
  ('app', 'cloudflare', 15.20, 15.20),
  ('app', 'porkbun', 15.84, 15.84),
  ('app', 'hostinger', 8.99, 24.99),
  ('app', 'namecheap', 16.98, 22.98),
  ('app', 'godaddy', 19.99, 28.99),
  ('app', 'ionos', 12.00, 25.00),
  ('app', 'namesilo', 16.49, 16.49),
  ('dev', 'spaceship', 12.88, 15.88),
  ('dev', 'cloudflare', 13.20, 13.20),
  ('dev', 'porkbun', 13.84, 13.84),
  ('dev', 'hostinger', 7.99, 22.99),
  ('dev', 'namecheap', 14.98, 20.98),
  ('dev', 'godaddy', 18.99, 26.99),
  ('dev', 'ionos', 10.00, 24.00),
  ('dev', 'namesilo', 14.49, 14.49),
  ('co', 'spaceship', 8.98, 27.98),
  ('co', 'cloudflare', 26.18, 26.18),
  ('co', 'porkbun', 25.99, 25.99),
  ('co', 'hostinger', 4.99, 34.99),
  ('co', 'namecheap', 11.98, 32.98),
  ('co', 'godaddy', 11.99, 39.99),
  ('co', 'ionos', 3.00, 35.00),
  ('co', 'namesilo', 25.99, 25.99),
  ('online', 'spaceship', 1.88, 38.88),
  ('online', 'cloudflare', 34.00, 34.00),
  ('online', 'porkbun', 2.84, 38.84),
  ('online', 'hostinger', 0.99, 39.99),
  ('online', 'namecheap', 2.98, 44.98),
  ('online', 'godaddy', 1.99, 49.99),
  ('online', 'ionos', 1.00, 45.00),
  ('online', 'namesilo', 2.99, 39.99),
  ('xyz', 'spaceship', 2.48, 12.98),
  ('xyz', 'cloudflare', 11.18, 11.18),
  ('xyz', 'porkbun', 2.84, 12.98),
  ('xyz', 'hostinger', 1.99, 18.99),
  ('xyz', 'namecheap', 2.98, 15.98),
  ('xyz', 'godaddy', 1.99, 21.99),
  ('xyz', 'ionos', 1.00, 19.00),
  ('xyz', 'namesilo', 2.89, 12.89),
  ('tech', 'spaceship', 3.48, 24.98),
  ('tech', 'cloudflare', 20.00, 20.00),
  ('tech', 'porkbun', 4.10, 23.85),
  ('tech', 'hostinger', 1.99, 25.99),
  ('tech', 'namecheap', 8.98, 24.98),
  ('tech', 'godaddy', 4.99, 27.99),
  ('tech', 'ionos', 2.00, 20.00),
  ('tech', 'namesilo', 4.29, 22.99)
) as seed(tld, registrar_id, register, renew)
where not exists (select 1 from public.registrar_prices);

-- ---------------------------------------------------------------------------
-- Daily refresh of Porkbun's prices (domain-search, action refreshPrices),
-- with the same Vault entries as the reminder job.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net')
     or not exists (select 1 from pg_namespace where nspname = 'vault') then
    raise notice 'pg_cron, pg_net or vault unavailable; refresh domain prices externally.';
    return;
  end if;

  perform cron.unschedule(jobid) from cron.job where jobname = 'domain-vault-prices';

  perform cron.schedule(
    'domain-vault-prices',
    '15 5 * * *',
    $job$
      select net.http_post(
        url     := (select decrypted_secret from vault.decrypted_secrets
                     where name = 'dv_functions_base_url') || '/domain-search',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
                             where name = 'dv_cron_secret')
        ),
        body    := '{"action":"refreshPrices"}'::jsonb,
        timeout_milliseconds := 30000
      )
      where exists (select 1 from vault.decrypted_secrets where name = 'dv_functions_base_url')
        and exists (select 1 from vault.decrypted_secrets where name = 'dv_cron_secret');
    $job$
  );
end $$;
