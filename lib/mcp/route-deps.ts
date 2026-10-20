import "server-only";
import type { AppEntry } from "@/lib/types";
import type { AdapterContext } from "@/lib/adapters/types";
import { getCatalog } from "@/lib/mcp/catalog";
import { authenticateApiKey } from "@/lib/auth/api-key";
import { runTool } from "@/lib/adapters/run";
import { adapterFor } from "@/lib/adapters/registry";
import { writeAudit, supabaseAuditSink, type AuditRow } from "@/lib/audit/log";
import { createAdminClient } from "@/lib/supabase/admin";
import { createHttp, type Http } from "@/lib/http/client";
import { createSecretReader, vaultFetcher } from "@/lib/secrets/vault";
import type { HandlerDeps } from "@/lib/mcp/handler";

// Route files (app/mcp/**/route.ts) may only export route handlers and Next.js config — the
// App Router rejects any other export from a route file. This module is where the two routes'
// shared wiring lives instead, so neither route imports helpers from the other.

export function extractKey(req: Request): string | null {
  const header = req.headers.get("x-api-key");
  if (header) return header;
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  // Case-insensitive per RFC 7235 (the `Bearer` auth-scheme token is case-insensitive) — Task
  // 11 fix round 1, minor item. The previous `startsWith("Bearer ")` silently rejected an
  // otherwise-valid `bearer <key>`/`BEARER <key>` header instead of accepting it.
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1] : null;
}

function dbDeps() {
  const supabase = createAdminClient();
  return {
    async lookup(prefix: string) {
      const { data } = await supabase
        .from("api_keys")
        .select("hash, org_id, user_id, revoked_at, expires_at, source, oauth_resource, organizations(slug)")
        .eq("prefix", prefix)
        .maybeSingle();
      if (!data) return null;
      const org = data.organizations as unknown as { slug: string } | null;
      return {
        hash: data.hash as string,
        org_id: data.org_id as string,
        org_slug: org?.slug ?? "",
        user_id: data.user_id as string,
        revoked_at: data.revoked_at as string | null,
        expires_at: (data.expires_at as string | null) ?? null,
        source: data.source as "manual" | "oauth",
        oauth_resource: (data.oauth_resource as string | null) ?? null,
      };
    },
    async rolesFor(userId: string, orgId: string) {
      const { data } = await supabase
        .from("role_assignments").select("role").eq("user_id", userId).eq("org_id", orgId);
      return (data ?? []).map((r) => r.role as string);
    },
    // S4 (Task 12 final review): stamps `api_keys.last_used_at` on every successful
    // authentication. `authenticateApiKey` already swallows any failure this throws/rejects
    // with — see lib/auth/api-key.ts's doc comment on `AuthDeps.touch` — so an error here is
    // never surfaced back to this function's own caller.
    async touch(prefix: string) {
      await supabase
        .from("api_keys")
        .update({ last_used_at: new Date().toISOString() })
        .eq("prefix", prefix);
    },
  };
}

// One `Http` per (org, app), created once and reused for the process lifetime — matching the
// same `${org}/${app}` key `lib/adapters/auth.ts`'s upstream-token cache already uses for this
// exact reason (see that file's doc comment). `createHttp`'s throttle state (`lastAt`) is
// closure-local to the client it belongs to (lib/http/client.ts): a fresh client per call
// resets that state every time, so `transport.minIntervalMs` bounds nothing. Task 11 fix round
// 2, finding A — this silently undid the whole throttle fix Task 8 shipped (measured
// collapsing to near-zero spacing under concurrency before that fix), and
// `lib/adapters/run.ts`'s own comment already asserts `ctx.http` is long-lived across every
// call for an app; a per-call client broke that assumption without anything failing loudly.
// Deferred (Task 11 fix round 3): this cache, like `lib/mcp/catalog.ts`'s catalog, has no
// invalidation path — if a config-reload feature is ever added, both need one together.
const httpClients = new Map<string, Http>();

function httpFor(entry: AppEntry): Http {
  const key = `${entry.org}/${entry.app}`;
  const existing = httpClients.get(key);
  if (existing) return existing;
  const client = createHttp(entry.config.transport);
  httpClients.set(key, client);
  return client;
}

// One secret reader per (org, app), created once and reused for the process lifetime — same
// `${org}/${app}` key `httpClients` above (and `lib/adapters/auth.ts`'s upstream-token cache)
// already use, and for the identical reason (S1, Task 12 final review). `createSecretReader`
// returns a closure over its own `cache`/`inFlight` Maps (lib/secrets/vault.ts): a fresh reader
// per call means both are empty every time, so the TTL cache never has a chance to hit and the
// in-flight dedup never has a chance to coalesce concurrent callers — every tool call re-fetches
// every secret it needs from Vault. Measured: 5 vault fetches across 5 calls to `buildContext`
// for the same (org, app) before this fix, 1 after.
const secretReaders = new Map<string, ReturnType<typeof createSecretReader>>();

function secretReaderFor(entry: AppEntry): ReturnType<typeof createSecretReader> {
  const key = `${entry.org}/${entry.app}`;
  const existing = secretReaders.get(key);
  if (existing) return existing;
  const reader = createSecretReader(vaultFetcher);
  secretReaders.set(key, reader);
  return reader;
}

/**
 * Builds the per-app adapter context. Lives here (rather than inline in the handler) per Task
 * 11 fix round 1, finding I6 — `HandlerDeps.buildContext` is what lets a test supply a fake
 * context and assert what the handler actually passes to `runTool`.
 */
export function buildContext(entry: AppEntry): Promise<AdapterContext> {
  return Promise.resolve({
    http: httpFor(entry),
    secret: secretReaderFor(entry),
    config: entry.config,
    log: (event: string, fields?: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields })),
  });
}

export function handlerDeps(): HandlerDeps {
  return {
    catalog: getCatalog(),
    // `authenticateApiKey` REJECTS (rather than resolving `null`) on an infrastructure
    // failure — lib/auth/api-key.ts's doc comment is explicit about this. This function is
    // handed to the handler as-is, unwrapped: the rejection must reach `handleMcpRequest`,
    // which is what actually catches it (never surfacing it as a 401, never leaking it to the
    // client) — see lib/mcp/handler.ts's `try { principal = await deps.authenticate(...) }`.
    // Swallowing or reshaping the rejection here would defeat that.
    authenticate: (key: string) => authenticateApiKey(key, dbDeps()),
    // The handler's contract stays four arguments; the tool's registered adapter (or none —
    // `adapterFor` returns an empty adapter for every unregistered tool, which is exactly
    // today's declarative path) is selected here, from the catalog entry and tool the handler
    // already resolved, never from anything in the request.
    runTool: (entry, tool, args, ctx) => runTool(entry, tool, args, ctx, adapterFor(entry.org, entry.app, tool.name)),
    // `redact` is the tool's own `audit.redact` list, computed per-call by the handler
    // (`tool.audit?.redact ?? []`) and threaded through here — `writeAudit`'s third parameter
    // is required, not optional, precisely so this call site cannot forget it.
    audit: (row: AuditRow, redact: string[]) => writeAudit(row, supabaseAuditSink, redact),
    buildContext,
  };
}
