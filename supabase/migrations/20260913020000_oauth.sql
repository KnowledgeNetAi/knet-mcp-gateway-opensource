-- Phase 2: OAuth 2.1 + dynamic client registration.
--
-- Two new tables, plus the columns that let an OAuth access token live in
-- `api_keys` alongside a manual key. That colocation is deliberate (phase 2
-- spec, decision 2): `authenticateApiKey` then validates both principal kinds
-- on one code path, and an OAuth token's org binding is structural — it is in
-- the token's own `kngw_<org>_...` prefix, not only in a column.
--
-- No GRANT to `authenticated` or `anon` anywhere below. Every table in this
-- schema is service-role only behind RLS (see 20260912000000_gateway_core.sql):
-- the gateway reads user sessions through Supabase Auth, but every read and
-- write of these tables goes through `createAdminClient()`. This is a
-- deliberate, documented deviation from the standing cross-project convention
-- of granting `authenticated` on new public tables.

create table public.oauth_clients (
  client_id                   text primary key,
  client_name                 text not null,
  redirect_uris               text[] not null,
  grant_types                 text[] not null default array['authorization_code','refresh_token'],
  token_endpoint_auth_method  text not null default 'none',
  registered_at               timestamptz not null default now(),
  registered_by               uuid references auth.users(id) on delete set null,
  disabled_at                 timestamptz
);

create table public.oauth_authorization_codes (
  code_hash             text primary key,
  client_id             text not null references public.oauth_clients(client_id) on delete cascade,
  user_id               uuid not null references auth.users(id) on delete cascade,
  -- The org this code was consented for, resolved from the RFC 8707 `resource`
  -- parameter while a human was looking at the consent screen. Carried into the
  -- issued token so the binding is decided at consent, never inferred later.
  org_id                uuid not null references public.organizations(id) on delete cascade,
  redirect_uri          text not null,
  scopes                text[] not null default '{}',
  code_challenge        text not null,
  code_challenge_method text not null default 'S256',
  resource              text,
  expires_at            timestamptz not null,
  consumed_at           timestamptz,
  created_at            timestamptz not null default now()
);

-- Supports the opportunistic sweep in lib/oauth/cleanup.ts, which filters on
-- expires_at and consumed_at.
create index oauth_authorization_codes_sweep_idx
  on public.oauth_authorization_codes (expires_at, consumed_at);

alter table public.api_keys
  add column source text not null default 'manual'
    check (source in ('manual', 'oauth')),
  add column oauth_client_id text references public.oauth_clients(client_id) on delete set null,
  -- NULL means "never expires": the manual-API-key case. lib/auth/api-key.ts
  -- treats a non-null-but-unparseable value as expired, failing closed.
  add column expires_at timestamptz,
  add column refresh_token_hash text,
  add column refresh_token_prefix text,
  add column scopes text[] not null default '{}';

-- Refresh-token lookup in rotateRefreshToken filters on (prefix, hash).
create index api_keys_refresh_idx
  on public.api_keys (refresh_token_prefix)
  where refresh_token_prefix is not null and revoked_at is null;

alter table public.oauth_clients              enable row level security;
alter table public.oauth_authorization_codes  enable row level security;
