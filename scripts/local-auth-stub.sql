-- LOCAL TEST DATABASE ONLY (scripts/local-db.sh). Never run against Supabase.
-- Supabase provides the auth schema in the cloud; this is the smallest stand-in the migrations
-- and tests/server need: users, identities, and auth.uid() reading the request's JWT claims.
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  created_at timestamptz not null default now(),
  unique (user_id, provider)
);

create or replace function auth.uid() returns uuid
language sql
stable
as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
