-- Bind OAuth credentials to the exact RFC 8707 resource authorized by the
-- user. Existing live OAuth credentials predate this column and have no
-- recoverable app audience, so revoke them rather than silently treating
-- them as org-wide. Manual API keys remain org-wide and keep NULL here.
alter table public.api_keys add column oauth_resource text;

update public.api_keys
set revoked_at = now()
where source = 'oauth'
  and revoked_at is null;

alter table public.api_keys
  add constraint api_keys_live_oauth_resource_check
  check (source <> 'oauth' or oauth_resource is not null or revoked_at is not null);

comment on column public.api_keys.oauth_resource is
  'Exact RFC 8707 resource for OAuth credentials; NULL for manual keys. Legacy OAuth rows were revoked when this column was introduced.';

-- Serialize platform-admin changes per organization. The prior application
-- code counted admins and then changed membership in separate statements, so
-- two concurrent requests could both observe two admins and leave zero.
-- Both functions take the same transaction-scoped advisory lock before they
-- inspect or mutate membership, making the invariant atomic across demotion
-- and removal.
create or replace function public.set_membership_admin_role(
  p_org_id uuid,
  p_user_id uuid,
  p_admin_role text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_role text;
begin
  if p_admin_role not in ('org_admin', 'member') then
    return 'invalid_admin_role';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org_id::text, 0));

  select m.admin_role into v_current_role
  from public.memberships m
  where m.org_id = p_org_id and m.user_id = p_user_id;

  if not found then
    return 'not_a_member';
  end if;

  if v_current_role = 'org_admin' and p_admin_role = 'member' and
     (select count(*) from public.memberships m
      where m.org_id = p_org_id and m.admin_role = 'org_admin') <= 1 then
    return 'last_admin';
  end if;

  update public.memberships
  set admin_role = p_admin_role
  where org_id = p_org_id and user_id = p_user_id;

  return 'ok';
end;
$$;

create or replace function public.remove_org_member(
  p_org_id uuid,
  p_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_role text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org_id::text, 0));

  select m.admin_role into v_current_role
  from public.memberships m
  where m.org_id = p_org_id and m.user_id = p_user_id;

  if not found then
    return 'not_a_member';
  end if;

  if v_current_role = 'org_admin' and
     (select count(*) from public.memberships m
      where m.org_id = p_org_id and m.admin_role = 'org_admin') <= 1 then
    return 'last_admin';
  end if;

  -- Keep revocation first inside the same transaction. If a later statement
  -- fails, PostgreSQL rolls the whole function call back atomically.
  update public.api_keys
  set revoked_at = now()
  where org_id = p_org_id and user_id = p_user_id and revoked_at is null;

  delete from public.role_assignments
  where org_id = p_org_id and user_id = p_user_id;

  delete from public.memberships
  where org_id = p_org_id and user_id = p_user_id;

  return 'ok';
end;
$$;

-- SECURITY DEFINER functions are executable by PUBLIC unless explicitly
-- revoked. Only the gateway's service-role client may call these mutations.
revoke all on function public.set_membership_admin_role(uuid, uuid, text) from public;
revoke all on function public.set_membership_admin_role(uuid, uuid, text) from anon, authenticated;
grant execute on function public.set_membership_admin_role(uuid, uuid, text) to service_role;

revoke all on function public.remove_org_member(uuid, uuid) from public;
revoke all on function public.remove_org_member(uuid, uuid) from anon, authenticated;
grant execute on function public.remove_org_member(uuid, uuid) to service_role;
