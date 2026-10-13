-- ============================================================================
-- Domain Vault — editable customer emails
--
-- The texts of the automated emails (welcome, activation, team invitation,
-- renewal reminder, purchases and subscriptions) and the brand around them,
-- edited in Admin → Emails. A template with no row here uses its default,
-- kept in functions/_shared/email.ts.
-- ============================================================================

create table if not exists public.email_templates (
  key        text primary key,
  subject    text not null,
  heading    text not null,
  body       text not null,
  button     text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint email_templates_key_shape check (key ~ '^[a-z_]{2,40}$'),
  constraint email_templates_lengths check (
    length(btrim(subject)) between 1 and 200 and length(heading) <= 200
    and length(body) <= 5000 and length(button) <= 60)
);

create table if not exists public.email_settings (
  id           boolean primary key default true,
  logo_url     text not null default 'https://ik.imagekit.io/bebell/Domain%20Vault/domain-assets-logos/Domain-vault-logo.webp',
  accent_color text not null default '#ff5011',
  footer_text  text not null default 'Domain Vault · getdomainvault.com',
  updated_at   timestamptz not null default now(),
  constraint email_settings_single check (id),
  constraint email_settings_logo check (logo_url = '' or (logo_url ~ '^https://[^\s"<>]+$' and length(logo_url) <= 500)),
  constraint email_settings_color check (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  constraint email_settings_footer check (length(footer_text) <= 300)
);

insert into public.email_settings (id) values (true) on conflict do nothing;

drop trigger if exists email_templates_set_updated_at on public.email_templates;
create trigger email_templates_set_updated_at
  before update on public.email_templates
  for each row execute function public.set_updated_at();

drop trigger if exists email_settings_set_updated_at on public.email_settings;
create trigger email_settings_set_updated_at
  before update on public.email_settings
  for each row execute function public.set_updated_at();

-- Service role only (the functions); admins edit through the api function.
alter table public.email_templates enable row level security;
alter table public.email_settings enable row level security;
revoke all on public.email_templates, public.email_settings from anon, authenticated;
