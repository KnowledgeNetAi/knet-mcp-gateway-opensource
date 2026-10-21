import type { AppConfig, AppEntry, OAuthAuthDef } from "@/lib/types";
import type { AdapterContext } from "./types";

/**
 * Every Vault path an app's `auth` block declares, by parameter name. Empty for
 * `type: "none"`, which has no credential to store.
 */
export function authSecrets(config: AppConfig): Record<string, string> {
  return config.auth.type === "none" ? {} : config.auth.secrets;
}

interface CachedToken { token: string; expiresAt: number }
const cache = new Map<string, CachedToken>();

/**
 * The `grant_type` each declared auth type sends. Keyed by `OAuthAuthDef["type"]`
 * so adding a member to that union without deciding its grant fails to
 * compile here rather than sending a missing/undefined `grant_type` to a real
 * identity provider.
 */
const GRANT_TYPES: Readonly<Record<OAuthAuthDef["type"], string>> = Object.freeze({
  oauth2_client_credentials: "client_credentials",
  oauth2_refresh_token: "refresh_token",
});

/**
 * Mints an upstream access token. `expires_in` may arrive as a string; coerce it.
 *
 * Cache key is `${entry.org}/${entry.app}` — matching the exact key
 * lib/config/load.ts's boot-time catalog already uses for this same (org,
 * app) pair. Structural, not conventional: an earlier version of this
 * function keyed on fields drawn from `AppConfig` alone (app name, tokenUrl,
 * client_id vault path), which is a mitigation at best. `AppConfig` carries
 * no org identity, `app` is equal by construction whenever two orgs
 * onboard the same product under the same name (lib/config/load.ts requires
 * the directory name to equal `config.app`), a multi-tenant SaaS vendor's
 * tokenUrl is the same for every customer, and the client_id/client_secret
 * vault-path convention is an unenforced comment, not a validated shape
 * (lib/config/schema.ts's `secrets` field is `z.record(z.string(),
 * z.string())`) — so a single unreviewed, half-parameterized `api.json`
 * (e.g. an org-qualified client_id path copy-pasted alongside a
 * *un*-qualified client_secret path) is enough to collide two different
 * orgs' tokens. Taking `AppEntry` instead of `AppConfig` closes that: `org`
 * is a distinct, always-populated field, so this is now a type-level
 * guarantee instead of a convention. See Task 9 fix round 1, finding 3, and
 * the report for the full reachability writeup and the (now superseded)
 * original mitigation.
 *
 * This talks to the identity provider directly with the platform `fetch`,
 * not `ctx.http`: the app's Http client is throttled/retried/timed-out per
 * *that app's* upstream API transport policy, which has nothing to do with
 * its identity provider. Routing the token call through it would also make
 * every tool call emit a second, unrelated request through whatever the
 * caller is observing on `ctx.http` (tests included). A network failure
 * here (DNS/connection/timeout) is a real, actionable failure and throws —
 * it must not be treated as "proceed with no credential," which would send
 * `Authorization: Bearer` (empty) to the real upstream API and let the
 * gateway believe it had authenticated. (An earlier version of this
 * function caught that failure and returned "" to work around the brief's
 * test fixture using a token endpoint on the intentionally-never-resolving
 * `.test` TLD; the test was fixed to stub `fetch` instead — see
 * lib/adapters/run.test.ts and the Task 9 report, fix round 1 finding 4.)
 */
export async function getUpstreamToken(entry: AppEntry, ctx: AdapterContext): Promise<string> {
  const { config } = entry;
  if (config.auth.type === "none") {
    throw new Error(`${entry.org}/${entry.app} declares auth type "none" and has no token to mint`);
  }
  const auth = config.auth;
  const key = `${entry.org}/${entry.app}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.token;

  const resolved = Object.fromEntries(
    await Promise.all(
      Object.entries(auth.secrets).map(
        async ([name, path]) => [name, await ctx.secret(path)] as const,
      ),
    ),
  );
  // Every declared secret goes into the body under its own name, rather than
  // two hardcoded keys. FieldEdge's client-credentials grant requires a third
  // parameter (`target_id`, the tenant) and there was previously no way to
  // express one. Backwards-compatible: Contoso declares exactly client_id
  // and client_secret, so its request body is byte-identical.
  //
  // This is also what makes the refresh-token grant a config-only difference:
  // HubSpot's refresh needs client_id + client_secret + refresh_token, and a
  // refresh_token declared in `auth.secrets` lands in the body under that
  // exact name with no special case here. The response's own `refresh_token`
  // is deliberately ignored — HubSpot does not rotate it, and a gateway that
  // silently wrote a new one back to Vault would turn a stored credential
  // into mutable state that git-reviewed config no longer describes. If a
  // future provider DOES rotate, this is the line that has to change, not a
  // config key.
  const body: Record<string, string> = { grant_type: GRANT_TYPES[auth.type], ...resolved };

  // `bodyFormat` was declared in the schema and validated since phase 1, but
  // nothing ever read it — this function hardcoded JSON. Service Fusion accepts
  // JSON so the gap never surfaced; FieldEdge's token endpoint REJECTS JSON and
  // requires form encoding.
  const isForm = auth.bodyFormat === "form";

  // Bounded like every other upstream call this gateway makes. `ctx.http`
  // already enforces `transport.timeoutMs` for the app's own API, but this
  // call deliberately bypasses `ctx.http` (see above), so nothing else on
  // this path would ever time it out — an unreachable identity provider
  // would otherwise hang the tool call indefinitely.
  const res = await fetch(auth.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": isForm ? "application/x-www-form-urlencoded" : "application/json",
    },
    body: isForm ? new URLSearchParams(body).toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(config.transport.timeoutMs),
    // A followed 307/308 would re-POST the client secret to whatever host
    // the Location header names.
    redirect: "manual",
  });
  if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}`);

  const json = (await res.json()) as Record<string, unknown>;
  const ttl = Number(json[auth.expiry.field]);
  if (!Number.isFinite(ttl)) throw new Error(`token response missing ${auth.expiry.field}`);

  // `expires_in` isn't the only field that must be validated: `access_token`
  // becomes the actual bearer credential sent upstream on every call until
  // it expires. `String(json.access_token)` on a response that omits it
  // would silently cache and serve the literal string "undefined" as a
  // token for the full TTL (Task 9 fix round 1, finding 5).
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new Error("token response missing access_token");
  }
  const token = json.access_token;

  cache.set(key, { token, expiresAt: Date.now() + (ttl - auth.expiry.skewSeconds) * 1000 });
  return token;
}
