-- supabase/migrations/20260912000000_gateway_core.sql

create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  name       text not null,
  created_at timestamptz not null default now()
);

create table public.memberships (
  user_id    uuid not null references auth.users(id) on delete cascade,
  org_id     uuid not null references public.organizations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, org_id)
);

-- `role` is a plain string resolved against roles.json at request time.
-- Deliberately NOT a foreign key: role definitions live in git, and a stale
-- row here must be inert, never a boot failure.
create table public.role_assignments (
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id  uuid not null references public.organizations(id) on delete cascade,
  role    text not null,
  primary key (user_id, org_id, role)
);

create table public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  prefix       text not null unique,   -- stored clear, used for lookup
  hash         text not null,          -- sha256 of the full key
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index api_keys_org_idx on public.api_keys (org_id) where revoked_at is null;

create table public.audit_events (
  id              bigint generated always as identity primary key,
  ts              timestamptz not null default now(),
  org_id          uuid references public.organizations(id) on delete set null,
  user_id         uuid references auth.users(id) on delete set null,
  principal_kind  text not null,
  app             text,
  tool            text,
  decision        text not null,
  args            jsonb,
  result_count    integer,
  upstream_status integer,
  duration_ms     integer,
  error           text
);
create index audit_events_org_ts_idx on public.audit_events (org_id, ts desc);
-- Supports the 90-day retention purge, which filters on `ts` alone -- the
-- non-leading column of the index above.
create index audit_events_ts_idx on public.audit_events (ts);

-- Every table is service-role only. The gateway never uses an anon client, and
-- the admin UI reads through server-side code that scopes by org.
alter table public.organizations   enable row level security;
alter table public.memberships     enable row level security;
alter table public.role_assignments enable row level security;
alter table public.api_keys        enable row level security;
alter table public.audit_events    enable row level security;

grant select, insert, update, delete on public.organizations   to service_role;
grant select, insert, update, delete on public.memberships     to service_role;
grant select, insert, update, delete on public.role_assignments to service_role;
grant select, insert, update, delete on public.api_keys        to service_role;
grant select, insert, update, delete on public.audit_events    to service_role;

-- 90-day retention (spec decision 7). Scheduled separately; documented here so
-- the window lives beside the table it bounds.
comment on table public.audit_events is 'Retention: 90 days. Contains customer PII in args.';
