@AGENTS.md

# mcp-gateway: working notes

## Onboarding or extending an app

**Audit the vendor's API, not our connector.** `orgs/<org>/<app>/api.json` is
a subset someone chose once. Before reporting that a capability is missing,
find the vendor's documentation and check. A capability audit that only reads
`api.json` will confidently report absent features that exist.

**Never declare a parameter you have not called.** Upstreams differ in how
they reject a bad one, and one of these is dangerous: some silently ignore an
unknown query parameter and return the whole unfiltered collection, so a
guessed filter name looks exactly like a successful narrowed query. Verify by
comparing `total` against the unfiltered baseline; unchanged means ignored.
Others 400 on an unknown filter name but return an empty set for an
unrecognized comparison form.

**Make the API enumerate itself.** An invalid sort or filter value often
returns an error naming every supported value. That error is better
documentation than most docs sites.

**Probe every declared filter before shipping.** `npm run probe-filters --
<org>/<app>` sends each filter alone with a no-match value and compares the
count to an unfiltered baseline (read-only, paced). `IGNORED?` means the
upstream may be dropping the parameter; `REJECTED` is either a wrong name or a
value format the tool's description must state. Also check that a filter
works alone; some ranges return nothing unless both bounds are given.

**Measure the rate limit; don't copy it.** The same script prints quota
headers. Declare them as `transport.rateLimit` so the client waits out an
exhausted window instead of burning retries.

**`maxPages` is our cap, not theirs.** `perPage 200 x maxPages 5` truncates
at 1,000 regardless of what the upstream would serve. Before reporting a
truncated result as a vendor limit, check whether we imposed it.

## Editing orgs/*/api.json and roles.json

**Edit as text, never reserialize.** These files are hand-formatted with
compact single-line nested objects. `json.load` then `json.dump` reformats the
whole file and escapes non-ASCII characters, turning a 30-line change into a
200-line diff. Use targeted string replacement and validate with
`python3 -c "import json; json.load(open(...))"`.

**A restricted role may not carry a wildcard.** `orgs/orgs.test.ts` and
`lib/policy/security.test.ts` reject `"allow": ["*"]` or a trailing `".*"` on
any role not listed in `UNRESTRICTED_ROLES`. Enumerate the fields. When the
tests fail on a grant you just widened, they are right.

**Register every adapter.** An `orgs/<org>/<app>/adapter.ts` must be imported
in `lib/adapters/registry.ts`; the loader refuses one that is not.

## Verifying a change end to end

`npm test` never touches a real Supabase project, a real upstream, or a real
MCP client, so it cannot tell you a tool actually works. For that:

1. `npm run dev` (port 3070).
2. Issue a key on the org's Keys page in `/admin`, labeled so you know it is
   temporary. Revoke it when done.
3. `POST http://localhost:3070/mcp/<org>/<app>` with `X-API-Key`.
4. Read the org's Audit page (or `audit_events`) for the true failure reason.
   The client is told "gateway_error" deliberately; only the audit row has
   `upstream_status`, `duration_ms` and the real error.

**`next dev` dirties the tree.** It rewrites `next-env.d.ts` to point at
`.next/dev/types/` and regenerates `AGENTS.md`. Revert `next-env.d.ts` before
committing.

## Supabase migrations

Every table the gateway uses is accessed with the service role only. A new
`public` table needs an explicit `grant ... to service_role` (see
`20260912000000_gateway_core.sql`); do not rely on default Data API grants.

## Deploying

`orgs/**` and `plugins/**` ship in the container image, so **a config-only
change still needs a rebuild and redeploy**. Vault secrets are the exception:
they are read at runtime and cached for 5 minutes.
