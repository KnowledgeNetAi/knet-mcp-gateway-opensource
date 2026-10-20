# Getting started

This walks from an empty Supabase project to Claude calling the demo app's
tools. Allow about 30 minutes. Nothing here needs upstream credentials: the
demo app calls the public DummyJSON API.

## 1. Create a Supabase project and apply the migrations

Create a project at supabase.com (the free tier is fine). Then, from the repo
root:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Or paste each file in `supabase/migrations/` into the SQL editor, in filename
order. The migrations grant table access to `service_role` only. The gateway
reads and writes through its server-side admin client and never exposes these
tables to the browser.

## 2. Configure Supabase Auth

Dashboard → Authentication:

1. **URL Configuration.** Set **Site URL** to where the gateway runs
   (`http://localhost:3070` for now, your public origin later). Add
   `http://localhost:3070/**` to **Redirect URLs**.
2. **Email templates.** Push the templates in `supabase/templates/` (the
   README there has the command), or set the **Invite user** link by hand to
   `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite` and
   the **Reset password** link to the same with `type=recovery`. Without this,
   invite links land on a Supabase page instead of the gateway's
   `/set-password`.

## 3. Configure and start the gateway

```bash
npm ci
cp .env.example .env.local
```

Fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY`
from Project Settings → API. Then:

```bash
npm run dev    # http://localhost:3070
```

## 4. Create the demo org and your account

The `demo` org's apps come from `orgs/demo/`, but the org itself is a
database row. Create it in the SQL editor:

```sql
insert into public.organizations (slug, name) values ('demo', 'Demo');
```

Invite yourself with the `owner` data role:

```bash
npm run invite -- you@example.com demo owner
```

Open the email, follow the link, and choose a password. Then make yourself
the platform's first super admin:

```bash
npm run grant-super-admin -- you@example.com
```

Sign in at `http://localhost:3070/login`. `/admin` now lists the `demo` org.
From here on you can create orgs and invite people in the console instead of
the terminal.

## 5. Issue an API key and call the tools

In the console, open **demo → Keys**, issue a key for yourself, and copy it.
It is shown once.

```bash
export KEY='kngw_demo_...'

curl -s http://localhost:3070/mcp/demo/helloworld \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s http://localhost:3070/mcp/demo/helloworld \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"helloworld_hello","arguments":{"name":"Ada"}}}'

curl -s http://localhost:3070/mcp/demo/helloworld \
  -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"helloworld_user_search","arguments":{"query":"Emily"}}}'
```

Tool names are always prefixed with the app name (`helloworld_hello`), on
both the app endpoint (`/mcp/demo/helloworld`) and the org-wide one
(`/mcp/demo`), so two apps in one org never collide.

## 6. See the field filter work

Roles are read on every request, so you can watch the filter change with the
key you already have. As `owner`, the `user_search` call above returns `ssn`,
`bank` and the rest of DummyJSON's sample record.

In **demo → Members**, change your own data roles to `viewer` only, then
repeat the `tools/list` and `user_search` calls. `user_create` is gone from
the list, and each user now carries only `id`, names, `email` and three
`company` fields. Set your role back to `owner` when you are done.

Every call, including denials, is in **demo → Audit**. The client only ever
sees a generic error; the audit row has the real reason, the upstream status
and the duration.

## 7. Connect Claude

**Claude Code** (API key):

```bash
claude mcp add --transport http demo http://localhost:3070/mcp/demo \
  --header "X-API-Key: $KEY"
```

Then ask Claude to "say hello through the demo connector" or "find the demo
user named Emily."

**claude.ai, Claude Desktop, Cowork** (OAuth): these need the gateway on a
public HTTPS origin. Deploy it (see "Deploying" in the README), update the
Supabase Site URL and redirect allowlist to that origin, then add a custom
connector with the URL `https://<your-origin>/mcp/demo`. Claude registers
itself, sends you to the gateway's sign-in page, and shows a consent screen
listing the tools your role grants.

## Next

Onboard your own API: copy `orgs/demo/helloworld` to `orgs/<your-org>/<app>`,
then follow "Onboarding your own API" in the README.
