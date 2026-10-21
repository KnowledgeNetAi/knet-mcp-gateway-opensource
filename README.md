# MCP Gateway

A multi-tenant gateway that exposes your company's APIs to Claude and other
MCP clients as MCP servers. Each organization gets its own endpoint, each
role gets its own set of tools and fields, every call is authenticated and
audited, and the field allowlists live in git where they are code-reviewed.

You describe an upstream API in JSON (`orgs/<org>/<app>/api.json`), say who
may call which tools and see which fields (`roles.json`), and the gateway
does the rest: MCP protocol, API keys, an OAuth 2.1 authorization server for
claude.ai and Claude Desktop, upstream token minting, pagination, retries and
rate limits, response field filtering, write allowlists, an admin console and
an audit log.

It ships with one working integration, [`orgs/demo/helloworld`](orgs/demo/helloworld/),
which calls the free [DummyJSON](https://dummyjson.com) sample API and needs
no credentials. Start there: [`docs/getting-started.md`](docs/getting-started.md)
takes you from an empty Supabase project to Claude calling the demo tools.

Originally built by [KnowledgeNet.ai](https://knowledgenet.ai) and released
under the MIT license.

## What this is

Each upstream API (an "app") is onboarded once as a committed, reviewed
directory under `orgs/<org>/<app>/`:

- **`api.json`**: the upstream base URL, how to authenticate to it, transport
  policy (throttling, retry, timeout, rate-limit headers), and the declarative
  tool catalog (each tool's request shape and, for a list tool, its
  pagination).
- **`roles.json`**: per-role tool access and, per tool, a field allowlist.
  Allowlists are deny-by-default. A field not named is never returned, and an
  allow entry grants a whole subtree only when it is itself a wildcard (`"*"`
  or a trailing `".*"`). A bare field name grants exactly that field, never
  anything nested under it, so upstream schema drift fails closed instead of
  leaking.
- **`adapter.ts`** (optional): code hooks for the cases JSON cannot express,
  such as a tool computed from several upstream reads, or an upstream that
  reports a missing record as a 500. See `lib/adapters/types.ts`.

At request time, an MCP client calls `POST /mcp/<org>` (every app in the org)
or `POST /mcp/<org>/<app>` (one app) with an org-scoped API key in
`X-API-Key` or `Authorization: Bearer <key>`. The gateway:

1. Authenticates the key (`lib/auth/api-key.ts`) against Supabase
   (`api_keys`, `role_assignments`).
2. Computes the caller's tool and field grant from their roles
   (`lib/policy/grants.ts`), unioned across every role they hold.
3. Serves `tools/list` and `tools/call` (`lib/mcp/handler.ts`), runs the
   upstream request through the declarative pipeline (`lib/adapters/run.ts`),
   and always filters the response against the caller's grant
   (`lib/policy/filter.ts`). Filtering happens in the handler, never inside an
   adapter, so a field cannot leak because an adapter author forgot to filter
   it.
4. Writes exactly one audit row per call (`lib/audit/log.ts`) to
   `audit_events`, redacting any argument a tool names in `audit.redact`.

A wrong-org key, an ungranted tool, and a nonexistent tool all look the same
to the caller (404 or "unknown tool"), never "forbidden," so a client cannot
learn what exists or who has access from the shape of an error. The true
reason always lands in the audit row.

## Stack

- Next.js (App Router) on Node 20.6+. The `AGENTS.md` note applies: this
  Next.js version differs from older ones, so read
  `node_modules/next/dist/docs/` before changing framework code.
- Supabase for Postgres, Auth (admin console and OAuth sign-in) and Vault
  (upstream credentials).
- A Dockerfile that builds a standalone image. It runs anywhere a container
  runs (Cloud Run, Fly.io, ECS, Kubernetes, a VM).

## Quick start

```bash
npm ci
cp .env.example .env.local   # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
npm run dev                  # http://localhost:3070
```

Then follow [`docs/getting-started.md`](docs/getting-started.md) to apply the
migrations, create the `demo` org, issue a key and call the demo tools.

Other commands:

```bash
npm test             # vitest: unit and integration tests, no live Supabase or upstream needed
npm run typecheck    # tsc --noEmit
npm run build        # next build
npm run probe-filters -- <org>/<app>   # check each declared filter against the live upstream
```

Run `npm ci`, tests, typecheck and build in CI on every push and pull
request. `orgs/orgs.test.ts` and
`lib/policy/security.test.ts` are part of `npm test` and are the config lint
that keeps a restricted role from carrying a wildcard. When they fail on a
grant you just widened, they are right.

## The demo app

`orgs/demo/helloworld` is a complete, minimal integration:

MCP clients see each tool prefixed with its app name (`helloworld_hello`).

| Tool | What it shows |
| --- | --- |
| `hello` | A tool answered entirely by `adapter.ts` (a `compose` hook), with no upstream call. |
| `user_search` | A paginated search: offset paging with custom parameter names (`limit`/`skip`), `itemsAt`, `totalCountAt`, `dedupeBy`. |
| `user_get` | A single-record read with a path parameter (`/users/{{userId}}`). |
| `user_create` | A write tool. DummyJSON simulates the create and stores nothing. |

It has two roles:

- **`viewer`** can call `hello`, `user_search` and `user_get`, and sees only
  `id`, names, `email` and three `company` fields. DummyJSON's sample records
  also carry `ssn`, `password` and `bank` data; a viewer never receives them.
- **`owner`** can call all four tools, reads every field, and may write only
  the six fields its `writes` allowlist names.

The app declares `"auth": { "type": "none" }` because DummyJSON is public. A
real integration uses an OAuth grant (below) or a header key.

There is also an example Claude plugin for it in
[`plugins/demo-helloworld`](plugins/demo-helloworld/), which members of the
`demo` org can download from the gateway's home page.

## Onboarding your own API

1. **Read the vendor's API documentation, not just what you plan to call.**
   Then create `orgs/<org>/<app>/api.json` and `roles.json`. Copy the demo app
   as a starting point. The directory name must equal `api.json`'s `app`
   field.
2. **Pick the upstream auth.** `auth.type` is one of:
   - `"none"`: a public API, or one whose key travels as a plain header. Put
     a header key in `requestHeaders` (header name to Vault path).
   - `"oauth2_client_credentials"` or `"oauth2_refresh_token"`: the gateway
     mints and caches an access token from `tokenUrl`. Every entry in
     `auth.secrets` is sent in the token request body under its own name, so
     a token endpoint that needs a third parameter (a tenant id, a refresh
     token) declares one more secret instead of needing code. `bodyFormat`
     is `"json"` or `"form"`, whichever the identity provider accepts.

   Every Vault path in `auth.secrets` and `requestHeaders` must start with
   `<org>/<app>/`. The loader enforces this, so a copy-pasted config cannot
   silently read another tenant's credential.
3. **Pick the pagination style** each list tool's upstream actually uses:
   `"page"` (`page`/`per-page`), `"offset"` (`limit`/`offset`), or `"cursor"`
   (`limit` plus an opaque token the previous response carried, at
   `cursorAt`). Parameter names are configurable per style. A cursor search
   sent as a POST body declares `pagination.in: "body"`.
4. **Write the roles.** Name fields explicitly. Only a role you list in
   `orgs/orgs.test.ts`'s `UNRESTRICTED_ROLES` may use a wildcard.
5. **Add a security test** modeled on `lib/policy/security.test.ts`: feed a
   poisoned record through the real loader, grant and filter, and assert that
   each restricted role cannot see what it should not.
6. **If you wrote an `adapter.ts`,** register it in
   `lib/adapters/registry.ts`. The loader refuses an unregistered one.
7. **Create the org and its people** in the admin console (or with
   `npm run invite`), store the credentials on the org's Credentials page,
   and click **Test connection**.
8. **Verify against the live upstream.** `npm test` never touches a real
   upstream. Run `npm run probe-filters -- <org>/<app>` and call each tool
   once with a real key.

`npm test` fails the build (`lib/config/load.ts`'s `ConfigError`) on a
role granting a tool that does not exist, a wildcard tool pattern matching
nothing, a field allowlist using a `deny` key, an unsupported `input` schema
shape, or a write tool no role can write through.

### Lessons from real upstreams

- **Never declare a parameter you have not called.** Some upstreams silently
  ignore an unknown query parameter and return the whole unfiltered
  collection, which looks exactly like a successful narrowed query. Compare
  the filtered `total` against the unfiltered one: unchanged means ignored.
  `npm run probe-filters` does this for every declared filter.
- **Make the API enumerate itself.** An invalid sort or filter value often
  returns an error that lists every valid one.
- **Measure the rate limit; don't copy it from third-party docs.** If the
  upstream sends quota headers, declare them in `transport.rateLimit` so the
  client waits out an exhausted window instead of burning retries.
- **`maxPages` is your cap, not the vendor's.** `perPage 200 x maxPages 5`
  truncates at 1,000. The result says `truncated` when that happens; check
  it before reporting a count as complete.

## Reads, searches and writes

The gateway serves `GET`, `POST` and `PATCH`. The HTTP verb alone does not say
what a tool does (many APIs search with a POST read and create with a POST
write), so the effect is decided by which block a tool declares, and a tool
that declares neither fails the build rather than being guessed at:

| Tool declares | Effect | Verb |
| --- | --- | --- |
| `list` | paginated read (list or search) | GET or POST |
| `write` | mutation | POST (create) or PATCH (update) |
| both | rejected: paging a mutation would re-submit it once per page | |
| neither, on a non-GET | rejected: effect undecidable from config | |

DELETE is deliberately absent. It has no fields, so the allowlist mechanism
that governs every other mutation would have nothing to say about it.

### Write policy

A write tool's `write.fieldsFrom` names the single argument carrying the
caller's field bag. That argument is the only one permitted to be an object,
and it is safe only because a role's `writes` allowlist governs its keys.

- **`writes` is separate from `fields`.** `fields` filters responses; `writes`
  gates request bodies. Without it, "can read deals" and "can edit deals"
  would be the same grant.
- **No wildcards in a `writes` allowlist, ever.** A wildcard write would let a
  caller overwrite a field nobody reviewed, including one the vendor adds
  later.
- **All-or-nothing.** A call naming one unwritable field is refused whole,
  not silently trimmed.
- **Every scalar leaf is named.** Nested objects and arrays are allowed only
  when every leaf has an exact allowlist path; array indices normalize to
  `[]` (for example, `contacts[].phones[].phone`).
- **Retry narrows to 429.** A 5xx or a truncated response may mean the
  upstream already applied the change, so writes are retried only on a 429.

Body templates interpolate `{{arg}}` placeholders with types preserved, and
drop any branch whose placeholder did not resolve, so an unsupplied filter
disappears instead of becoming a malformed one.

## Administering the gateway

The console lives at `/admin`. There are two platform roles:

| Role | Stored in | Can |
| --- | --- | --- |
| `super_admin` | `platform_admins` | create orgs and administer any org |
| `org_admin` | `memberships.admin_role` | invite and remove people, assign roles, manage credentials and keys, read the audit log for their own org |
| `member` | `memberships.admin_role` | sign in, consent to an OAuth connection, and hold data-access roles |

These are not the roles in `roles.json`. Those (`viewer`, `owner`, …) are
data-access roles that decide which tools and fields a principal reaches.
They live in git and an unrecognized one is inert by design. The two
vocabularies are kept in separate tables so neither can weaken the other.

An organization created in the console is a database row and nothing more.
Its apps, tools and field allowlists still arrive only by committing
`orgs/<slug>/<app>/`, so the allowlists that keep one tenant's data out of
another's results stay code-reviewed.

The first super admin is granted from a terminal:

```bash
npm run grant-super-admin -- <email>
```

Upstream credentials are write-only in the console. A stored secret is never
rendered back, not even masked, and the form is generated from each app's
`auth.secrets`, so a new provider needs no console code.

## Connecting a client

- **API key** (`X-API-Key`, or `Authorization: Bearer <key>`): for Claude Code
  and any client that can send a custom header. Issue keys on the org's Keys
  page.
- **OAuth 2.1 with dynamic client registration**: for claude.ai, Claude
  Desktop and Cowork, whose custom connectors offer an OAuth sign-in rather
  than a header field. The gateway hosts its own authorization server
  (`/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, and
  the `/.well-known/oauth-authorization-server` and
  `/.well-known/oauth-protected-resource/mcp/<org>[/<app>]` documents). A
  user signs in, sees a consent screen listing the tools their role grants,
  and on Allow the gateway mints a token in the same `kngw_<org>_<hex>.<secret>`
  shape a manual key uses, so both kinds of principal share one validation
  path. Tokens are bound to the resource (org, and optionally app) they were
  issued for.

Either way the request lands on the same `/mcp/<org>[/<app>]` endpoint and
goes through the same authentication, policy, filtering and audit pipeline.

## Deploying

Build the Docker image and run it with the three Supabase environment
variables from `.env.example`. The image listens on port 8080.

`orgs/` and `plugins/` are copied into the image, so **a config change needs a
rebuild and redeploy**. Vault secrets are the exception: they are read at
runtime and cached for 5 minutes.

**Set `CANONICAL_ORIGIN` in every deployment** to your public URL (for
example `https://gateway.example.com`). Invite and password-reset emails take
their links from it; without it they fall back to the request's
`X-Forwarded-Host`, which a client controls. It also redirects browser pages
from a platform host (`*.run.app`, `*.vercel.app`) to your domain, so cookies
use the right origin. MCP and OAuth endpoints are never redirected.

In Supabase, set the Auth Site URL to the same origin and add `<origin>/**`
to the redirect allowlist. A wildcard path on your own origin is fine; never
allow a wildcard host (`https://*.run.app/**`), which would let a forged
request point a real reset email at someone else's site. Push the email templates in `supabase/templates/` (see
the README there). Supabase's built-in email sender is rate-limited; configure
your own SMTP before inviting more than a handful of people.

### Security notes for deployers

- Dynamic client registration is open by design (claude.ai registers itself).
  It is rate-limited per IP in memory, per instance, keyed on the rightmost
  `X-Forwarded-For` entry (`lib/oauth/client-ip.ts`). That is the caller's
  address on Vercel and on Cloud Run without a load balancer. Behind a
  Google external load balancer, or any proxy of your own, the rightmost
  entry is the proxy, so every caller shares one bucket; adjust that
  function to skip your proxies. For a hard limit, also
  rate-limit `/oauth/register` at your load balancer. Registrations that
  never complete a token exchange are deleted after a week.
- Setting `oauth_clients.disabled_at` revokes every token that client holds.
- The gateway never follows an upstream redirect. An upstream that answers
  with a 3xx fails the call; point `baseUrl` at the final location.
- `audit_events` stores tool arguments, which can include customer data.
  Name sensitive arguments in each tool's `audit.redact`, and keep the
  90-day retention job described in `supabase/migrations/README.md`.

## Rotating a Vault secret

Save the new value on the org's Credentials page, or update it in Supabase
Vault under its existing name (`<org>/<app>/<key>`). Nothing else changes: no
code, no deploy, no `api.json` edit. The gateway may serve the old value for
up to 5 minutes (`lib/secrets/vault.ts` caches reads); restart it if the old
credential must stop working immediately.

## Repository layout

| Path | What it holds |
| --- | --- |
| `app/` | Next.js routes: `/mcp`, `/oauth`, `/.well-known`, `/admin`, sign-in pages, plugin downloads |
| `lib/adapters/` | the declarative request pipeline, upstream auth, adapter hooks and registry |
| `lib/policy/` | grants, field filtering, write policy, path matching |
| `lib/config/` | the `api.json`/`roles.json` schema and loader |
| `lib/oauth/` | the authorization server |
| `lib/admin/` | console data access |
| `orgs/` | one directory per org and app |
| `plugins/` | Claude plugins served to org members |
| `supabase/` | migrations and auth email templates |
| `scripts/` | `invite`, `grant-super-admin`, `probe-filters`, `build-plugin.sh` |

## License

MIT. See [LICENSE](LICENSE).
