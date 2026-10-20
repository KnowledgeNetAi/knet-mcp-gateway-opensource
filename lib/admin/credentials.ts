import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCatalog } from "@/lib/mcp/catalog";
import { createSecretReader, vaultFetcher } from "@/lib/secrets/vault";
import { authSecrets, getUpstreamToken } from "@/lib/adapters/auth";
import type { AdapterContext } from "@/lib/adapters/types";

export interface CredentialField {
  app: string;
  key: string;
  vaultName: string;
  isSet: boolean;
  updatedAt: string | null;
}

/**
 * One row per `auth.secrets` entry across every app this org has committed
 * to git — nothing is hardcoded per provider. Service Fusion's `api.json`
 * declares `client_id`/`client_secret`; FieldEdge declares those plus
 * `target_id`; HubSpot declares those two plus `refresh_token` (its grant is
 * refresh_token, not client_credentials, and that difference is entirely a
 * config one — see lib/adapters/auth.ts); a future provider renders whatever
 * it declares. Order follows
 * declaration order in `api.json` (`Object.entries` on a plain object with
 * string keys preserves insertion order), and apps are sorted by name for a
 * stable page render.
 *
 * `isSet` is read through the existing `public.read_vault_secret` RPC — the
 * only Vault read path PostgREST allows (see `lib/secrets/vault.ts`) — used
 * here ONLY to test presence: the decrypted value crosses into this
 * function's memory for a moment and is discarded immediately. It is never
 * assigned to any field of the returned `CredentialField`, never logged, and
 * never reaches a caller.
 *
 * There is no `select name, updated_at from vault.secrets`-equivalent RPC —
 * adding one would mean a new migration, which is out of scope for this
 * task (see the plan's Global Constraints). `updatedAt` is instead
 * approximated from the most recent successful `credential.write` audit row
 * recorded for this exact vault name: an accurate timestamp for anything set
 * through this console, and `null` for a secret that predates the console or
 * was seeded outside it (e.g. directly via the Supabase dashboard). `null`
 * is a legitimate, expected value here, not a bug.
 */
export async function credentialFieldsFor(orgSlug: string): Promise<CredentialField[]> {
  const supabase = createAdminClient();

  const entries = [...getCatalog().values()]
    .filter((entry) => entry.org === orgSlug)
    .sort((a, b) => a.app.localeCompare(b.app));

  const fields: CredentialField[] = [];

  for (const entry of entries) {
    for (const [key, vaultName] of Object.entries(authSecrets(entry.config))) {
      // Test presence only. The decrypted value (`data`) is deliberately
      // never stored anywhere but this local variable, and only its
      // nullness is inspected below.
      const { data, error } = await supabase.rpc("read_vault_secret", { p_name: vaultName });
      const isSet = !error && data !== null && data !== undefined;

      let updatedAt: string | null = null;
      const { data: auditRows } = await supabase
        .from("admin_audit_events")
        .select("ts")
        .eq("action", "credential.write")
        .eq("target", vaultName)
        .eq("outcome", "ok")
        .order("ts", { ascending: false })
        .limit(1);
      const latest = (auditRows as Array<{ ts: string }> | null)?.[0];
      if (latest) updatedAt = latest.ts;

      fields.push({ app: entry.app, key, vaultName, isSet, updatedAt });
    }
  }

  return fields;
}

/**
 * Writes one Vault secret through `public.write_vault_secret` (service-role
 * only — see `supabase/migrations/20260914000000_admin_console.sql`).
 *
 * `vaultName` must start with `<ctx.orgSlug>/` — the exact invariant
 * `lib/config/load.ts` already enforces at boot for every committed
 * `api.json`. Enforced here too, at write time, so an org_admin (scoped to
 * their own org by `requireOrgAdmin`) can never overwrite another tenant's
 * credential by supplying an arbitrary vault name — the check is on the
 * literal path prefix, including the separating slash, so an org whose slug
 * merely shares characters with another (e.g. "contoso" vs
 * "contoso-2") cannot cross the boundary either.
 */
export async function writeCredential(
  vaultName: string,
  value: string,
  ctx: { orgSlug: string },
): Promise<void> {
  const prefix = `${ctx.orgSlug}/`;
  if (!vaultName.startsWith(prefix)) {
    throw new Error(
      `vault name "${vaultName}" does not belong to org "${ctx.orgSlug}" (must start with "${prefix}")`,
    );
  }

  // The prefix check alone is not enough. `vaultName` reaches the Server
  // Action as a hidden form field, so it is caller-controlled: the prefix
  // rule stops one org's admin from overwriting another org's credential,
  // but still permits writing an arbitrary NAME inside their own org —
  // seeding Vault entries nothing reads, or shadowing a name a future
  // api.json might adopt. Only a name this org's committed config actually
  // declares is writable, which makes git the sole authority on which
  // secrets exist (the same seam lib/config/load.ts enforces at boot).
  const declared = new Set(
    [...getCatalog().values()]
      .filter((entry) => entry.org === ctx.orgSlug)
      .flatMap((entry) => Object.values(authSecrets(entry.config))),
  );
  if (!declared.has(vaultName)) {
    throw new Error(
      `vault name "${vaultName}" is not declared by any app in org "${ctx.orgSlug}"`,
    );
  }

  const supabase = createAdminClient();
  const { error } = await supabase.rpc("write_vault_secret", {
    p_name: vaultName,
    p_secret: value,
  });
  if (error) {
    throw new Error(`error writing credential "${vaultName}": ${error.message}`);
  }
}

/**
 * Mints an upstream token through the existing auth path
 * (`lib/adapters/auth.ts`'s `getUpstreamToken`, whichever grant the app
 * declares — client_credentials or refresh_token) and reports pass/fail plus an
 * HTTP status ONLY. `getUpstreamToken` never reads the upstream response body
 * unless the request actually succeeded (`res.json()` is only called after
 * `res.ok`), so a failing response's body — which is exactly where a leaked
 * access token would live — never enters this process on the failure path
 * this function reports through. `safeDetail` is a second, independent layer
 * on top of that: even if `getUpstreamToken`'s error message ever changed
 * shape, only an `HTTP <status>` substring (or a fixed fallback string) can
 * ever reach the caller from here.
 */
export async function testConnection(
  orgSlug: string,
  app: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const entry = getCatalog().get(`${orgSlug}/${app}`);
  if (!entry) return { ok: false, detail: "no such app" };
  if (entry.config.auth.type === "none") return { ok: false, detail: "this app has no upstream credential" };

  const ctx: AdapterContext = {
    // getUpstreamToken talks to the identity provider directly via the
    // platform `fetch`, never through `ctx.http` (see lib/adapters/auth.ts's
    // own doc comment) — this stub exists only to satisfy AdapterContext's
    // shape and must never actually be called on this path.
    http: {
      request: async () => {
        throw new Error("testConnection: ctx.http must not be used by the token-mint path");
      },
    },
    secret: createSecretReader(vaultFetcher),
    config: entry.config,
    log: () => {},
  };

  try {
    await getUpstreamToken(entry, ctx);
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: safeDetail(e) };
  }
}

/**
 * Narrows an upstream auth failure down to an HTTP status (or a fixed
 * fallback) — never the error's full message, and never anything derived
 * from a response body. This is the last line of defense for decision 8: a
 * console that can display a tenant's client secret is one authorization bug
 * away from leaking every tenant's, and a token-mint failure's body is
 * exactly where that secret's issued token would appear.
 */
function safeDetail(e: unknown): string {
  if (e instanceof Error) {
    const match = /HTTP \d+/.exec(e.message);
    if (match) return match[0];
  }
  return "connection failed";
}
