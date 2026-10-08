-- ============================================================================
-- Domain Vault — tools and recommendations, managed from the admin panel
--
-- The Tools page and the "Recommended providers" lists in the app were
-- hard-coded in script.js, so every change meant editing code. They now live
-- here and are edited in Admin → Tools.
--
--   kind = 'provider'  a registrar or host: shown in the app's domain and
--                      provider forms ("Recommended providers") and on the
--                      Tools page
--   kind = 'tool'      shown on the Tools page only
--
-- Public read of active items (they are links shown to every user); writes
-- go through the api function, which checks the admin and audits.
-- ============================================================================

create table if not exists public.catalog_items (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'tool',
  name        text not null,
  description text not null default '',
  url         text not null,
  icon        text not null default 'globe',
  rating      numeric(2,1) not null default 5,
  tags        text[] not null default '{}',
  sort        integer not null default 100,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint catalog_kind_valid   check (kind in ('provider', 'tool')),
  constraint catalog_name_len     check (length(btrim(name)) between 1 and 80),
  constraint catalog_desc_len     check (length(description) <= 200),
  constraint catalog_url_valid    check (url ~ '^https?://[^\s"<>]+$' and length(url) <= 500),
  constraint catalog_icon_valid   check (icon ~ '^[a-z0-9-]{1,40}$'),
  constraint catalog_rating_range check (rating between 0 and 5),
  constraint catalog_tags_valid   check (cardinality(tags) <= 8 and array_to_string(tags, ',') ~ '^[a-z0-9,-]*$')
);

create index if not exists catalog_items_order_idx on public.catalog_items (sort, name);

drop trigger if exists catalog_items_set_updated_at on public.catalog_items;
create trigger catalog_items_set_updated_at
  before update on public.catalog_items
  for each row execute function public.set_updated_at();

alter table public.catalog_items enable row level security;

drop policy if exists catalog_items_read_active on public.catalog_items;
create policy catalog_items_read_active on public.catalog_items
  for select to anon, authenticated
  using (active);

revoke insert, update, delete on public.catalog_items from anon, authenticated;
grant select on public.catalog_items to anon, authenticated;

-- Seed with what script.js showed, once (an empty table means "never seeded").
insert into public.catalog_items (kind, name, description, url, icon, rating, tags, sort)
select * from (values
  ('provider', 'Namecheap',        'Best for budget domains',                    'https://namecheap.com/',                          'tag',            5.0, array['domains'],                    10),
  ('provider', 'Porkbun',          'Great UI & pricing',                         'https://porkbun.com/',                            'piggy-bank',     5.0, array['domains'],                    20),
  ('provider', 'Hostinger',        'Domain + Hosting bundles',                   'https://hostinger.com/',                          'server',         4.5, array['domains','hosting'],          30),
  ('provider', 'IONOS',            'Domain registration',                        'https://ionos.com/domains/',                      'globe',          4.3, array['domains'],                    40),
  ('provider', 'Cloudflare',       'Cheapest renewals, at-cost',                 'https://www.cloudflare.com/products/registrar/', 'globe',          4.8, array['domains','cheap-renewal'],    50),
  ('provider', 'GoDaddy',          'Biggest TLD catalog, costly renewals',       'https://www.godaddy.com/domains',                 'globe',          3.9, array['domains','premium-renewal'],  60),
  ('tool',     'Google Workspace', 'Professional email & collaboration.',        'https://workspace.google.com/',                   'mail',           5.0, array['email'],                     110),
  ('tool',     'ProtonMail',       'Privacy-focused secure email.',              'https://proton.me/mail',                          'shield',         4.5, array['email'],                     120),
  ('tool',     'DigitalOcean',     'Developer-friendly cloud hosting.',          'https://digitalocean.com/',                       'cloud',          4.5, array['hosting'],                   130),
  ('tool',     'Vercel',           'Simple scalable deployment for frontend apps.', 'https://vercel.com/',                          'triangle',       5.0, array['hosting'],                   140),
  ('tool',     'MXToolbox',        'Comprehensive DNS & Email diagnostics',      'https://mxtoolbox.com',                           'mail-search',    5.0, array['dns','email'],               150),
  ('tool',     'DNSChecker',       'Global DNS propagation check',               'https://dnschecker.org',                          'globe-2',        5.0, array['dns'],                       160),
  ('tool',     'Whois.com',        'Domain lookup & registration info',          'https://whois.com',                               'search',         4.0, array['domains'],                   170),
  ('tool',     'Cloudflare DNS',   'Free DNS management & fast CDN',             'https://cloudflare.com',                          'cloud-lightning', 5.0, array['dns','hosting'],            180),
  ('tool',     'ICANN Lookup',     'Official domain registration data',          'https://lookup.icann.org/',                       'building-2',     4.5, array['domains'],                   190),
  ('tool',     'SSL Checker',      'Verify SSL certificate installation',        'https://www.sslshopper.com/ssl-checker.html',     'shield-check',   4.5, array['ssl'],                       200)
) as seed(kind, name, description, url, icon, rating, tags, sort)
where not exists (select 1 from public.catalog_items);
