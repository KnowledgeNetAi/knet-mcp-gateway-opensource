-- Disabling an OAuth client must end its access, not only stop new consents.
-- Before this, `oauth_clients.disabled_at` was read only by /oauth/authorize,
-- so a disabled client's access tokens kept working until they expired and its
-- refresh tokens kept rotating indefinitely. Revoking every credential the
-- client holds, in the same statement that disables it, makes the switch
-- immediate and impossible to forget.
create or replace function public.revoke_disabled_oauth_client_keys()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.disabled_at is not null and old.disabled_at is null then
    update public.api_keys
    set revoked_at = pg_catalog.now()
    where oauth_client_id = new.client_id
      and revoked_at is null;
  end if;
  return new;
end;
$$;

revoke all on function public.revoke_disabled_oauth_client_keys() from public, anon, authenticated;

create trigger oauth_clients_disable_revokes_keys
  after update of disabled_at on public.oauth_clients
  for each row
  execute function public.revoke_disabled_oauth_client_keys();

-- Dynamic client registration is unauthenticated by design, so registrations
-- that never completed a token exchange accumulate. This removes them once
-- they are a week old. Called, sampled, from the token endpoint's sweep.
create or replace function public.sweep_unused_oauth_clients()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.oauth_clients c
  where c.registered_at < pg_catalog.now() - interval '7 days'
    and not exists (select 1 from public.api_keys k where k.oauth_client_id = c.client_id)
    and not exists (select 1 from public.oauth_authorization_codes a where a.client_id = c.client_id);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.sweep_unused_oauth_clients() from public, anon, authenticated;
grant execute on function public.sweep_unused_oauth_clients() to service_role;
