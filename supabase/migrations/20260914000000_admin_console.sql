-- Phase 3: the admin console.
--
-- Platform roles, kept strictly separate from the data-access roles in
-- `role_assignments` (git-defined, per org/app -- see
-- 20260912000000_gateway_core.sql). `admin_role` on `memberships` answers
-- "can this person administer the org they already belong to"; the global
-- `platform_admins` grant answers "can this person administer any org,
-- including ones they do not belong to." Neither is ever written into
-- `role_assignments` -- that table's rows are validated against
-- `roles.json` at request time, and an unrecognized role there must stay
-- inert, not become a platform capability by accident.
--
-- `admin_audit_events` is deliberately a separate table from `audit_events`.
-- `audit_events.decision` is a closed union describing tool calls and carries
-- customer PII under a 90-day retention window; admin actions carry no
-- upstream PII and are exactly the records worth keeping longer. Different
-- shape, different lifecycle, different table.
--
-- No GRANT to `authenticated` or `anon` anywhere below. Every table in this
-- schema is service-role only behind RLS (see 20260912000000_gateway_core.sql
-- and 20260913020000_oauth.sql): the console reads the signed-in user's
-- session through Supabase Auth, but every read and write of these tables
-- goes through `createAdminClient()` behind an explicit authorization check
-- in `lib/authz/viewer.ts`. This is the same deliberate, documented deviation
-- from the standing cross-project convention of granting `authenticated` on
-- new public tables -- not an oversight to be "fixed" later.

alter table public.memberships
  add column admin_role text not null default 'member'
    check (admin_role in ('org_admin', 'member')),
  add column invited_by uuid references auth.users(id) on delete set null,
  add column invited_at timestamptz;

create table public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now()
);

create table public.admin_audit_events (
  id              bigint generated always as identity primary key,
  ts              timestamptz not null default now(),
  actor_user_id   uuid references auth.users(id) on delete set null,
  actor_was_super boolean not null default false,
  -- Nullable: org.create and superadmin.grant have no org. on delete set null
  -- keeps the record of an org's deletion after the org is gone.
  org_id          uuid references public.organizations(id) on delete set null,
  action          text not null,
  target          text,
  detail          jsonb,
  outcome         text not null check (outcome in ('ok', 'denied', 'error'))
);
create index admin_audit_events_org_ts_idx on public.admin_audit_events (org_id, ts desc);
create index admin_audit_events_ts_idx     on public.admin_audit_events (ts);

alter table public.platform_admins     enable row level security;
alter table public.admin_audit_events  enable row level security;

grant select, insert, update, delete on public.platform_admins    to service_role;
grant select, insert, update, delete on public.admin_audit_events to service_role;

-- Vault write path.
--
-- Reads already go through `public.read_vault_secret` (service-role only;
-- see 20260913010000_read_vault_secret.sql for why `vault` is not exposed to
-- PostgREST). Writing needs the mirror image, with identical discipline:
-- SECURITY DEFINER to reach `vault` without a schema grant, `set search_path
-- = ''` so every identifier below must be schema-qualified (an empty search
-- path resolves nothing, so a caller who can create objects earlier on the
-- search path cannot shadow `vault.secrets` or `vault.create_secret`), and no
-- dynamic SQL -- both the name and the secret are passed as parameters, so
-- they are data and can never be executed.
--
-- Upsert by name: vault.create_secret for a name not yet present,
-- vault.update_secret(id, secret) for one that is.
create or replace function public.write_vault_secret(p_name text, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  select s.id into v_id from vault.secrets s where s.name = p_name;
  if v_id is null then
    perform vault.create_secret(p_secret, p_name);
  else
    perform vault.update_secret(v_id, p_secret);
  end if;
end;
$$;

-- Postgres grants EXECUTE on a new function to PUBLIC by default. The revoke
-- is the point, not the grant: on a SECURITY DEFINER function that writes
-- Vault, an ungranted PUBLIC default would let any role -- `anon` included --
-- overwrite any tenant's credentials by name.
revoke all on function public.write_vault_secret(text, text) from public;
revoke all on function public.write_vault_secret(text, text) from anon, authenticated;
grant execute on function public.write_vault_secret(text, text) to service_role;

comment on function public.write_vault_secret(text, text) is
  'Gateway-only Vault write. service_role only; see migration for why vault is not exposed to PostgREST.';
