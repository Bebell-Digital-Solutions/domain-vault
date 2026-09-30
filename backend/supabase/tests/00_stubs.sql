-- ============================================================================
-- Stubs for the objects a real Supabase project provides (auth schema, storage
-- schema, the four platform roles), so the migrations and their security
-- properties can be tested on a plain Postgres container.
--
-- Not applied to a real project — run-tests.sh loads it into a throwaway
-- container only. On Supabase these objects already exist.
-- ============================================================================
create role anon;
create role authenticated;
create role service_role;
create role supabase_admin;

create schema if not exists auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create schema if not exists storage;
create table storage.buckets (
  id text primary key, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text, name text
);
create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$ select string_to_array(name, '/'); $$;

-- Supabase grants these to its roles out of the box.
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;
