-- Read a Vault secret by name, for the gateway's service-role client.
--
-- WHY THIS EXISTS. `lib/secrets/vault.ts` originally selected
-- `vault.decrypted_secrets` directly through supabase-js. That cannot work:
-- PostgREST exposes only `public` and `graphql_public`, so the request comes
-- back `PGRST106 Invalid schema: vault` and every tool call fails as
-- `gateway_error` with the real reason visible only in the server log. No
-- automated test caught it because the whole Supabase client is mocked in
-- `vault.test.ts`; phase 1 manual verification step 5 was the first thing to
-- execute the real path.
--
-- The obvious alternative — adding `vault` to the project's exposed schemas —
-- was rejected. It publishes the decrypted-secrets view on the same Data API
-- surface `anon` reaches, so the only thing standing between a client
-- credential and the internet becomes a grant nobody re-checks. A function
-- keeps the schema unexposed and makes the read an explicitly granted
-- capability instead of an ambient one.
--
-- SECURITY DEFINER is what lets the caller read `vault` without any grant on
-- the schema itself. Two guards make that safe:
--   * `set search_path = ''` — without it, a caller who can create objects in a
--     schema earlier on the search path could shadow `decrypted_secrets` and
--     make this function read their table instead. Every name below is
--     schema-qualified because an empty search_path resolves nothing.
--   * `stable`, and a single parameterised equality — no dynamic SQL, so the
--     name argument is data and can never be executed.
create or replace function public.read_vault_secret(p_name text)
returns text
language sql
security definer
set search_path = ''
stable
as $$
  select vs.decrypted_secret
  from vault.decrypted_secrets vs
  where vs.name = p_name;
$$;

-- Postgres grants EXECUTE on a new function to PUBLIC by default, which on a
-- SECURITY DEFINER function reading Vault would hand every role — `anon`
-- included — an oracle returning any secret by name. The revoke is the whole
-- point of this block; the grant merely restores what the gateway needs.
--
-- Note this deliberately does NOT follow the usual "grant to authenticated"
-- convention for new objects in `public`. That convention exists so ordinary
-- application tables stay reachable through the Data API. This is the opposite
-- case: a signed-in end user must never read another tenant's upstream
-- credentials, and the gateway only ever connects as `service_role`.
revoke all on function public.read_vault_secret(text) from public;
revoke all on function public.read_vault_secret(text) from anon, authenticated;
grant execute on function public.read_vault_secret(text) to service_role;

comment on function public.read_vault_secret(text) is
  'Gateway-only Vault read. service_role only; see migration for why vault is not exposed to PostgREST.';
