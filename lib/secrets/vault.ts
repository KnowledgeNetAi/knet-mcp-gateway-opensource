import { createAdminClient } from "@/lib/supabase/admin";

export type SecretFetcher = (path: string) => Promise<string | null>;

const DEFAULT_TTL_MS = 5 * 60_000;

type ErrorClass = "permission" | "network" | "timeout" | "unknown";

// Allowlist membership only — never format-validated-then-interpolated. An
// error's `.code` (or, from an inner layer, an already-classified class
// name) is looked up as an object key; anything that isn't an exact match
// falls through to "unknown". So a hostile `.code` can never itself reach
// the message: it either isn't a key here, or it is one of the four literal
// strings this module owns.
const KNOWN_ERROR_CODES: Readonly<Record<string, ErrorClass>> = Object.freeze({
  "42501": "permission", // Postgres: insufficient_privilege
  PGRST301: "permission", // PostgREST: JWT/permission error
  ETIMEDOUT: "timeout",
  ECONNRESET: "network",
  ECONNREFUSED: "network",
  ENOTFOUND: "network",
  EAI_AGAIN: "network",
  // Idempotent: a class name already assigned by an inner layer (e.g.
  // vaultFetcher's own catch) survives being classified again by an outer
  // layer (createSecretReader's catch) instead of regressing to "unknown".
  permission: "permission",
  network: "network",
  timeout: "timeout",
});

function classifyError(err: unknown): ErrorClass {
  // The whole body is wrapped: `err` is attacker-influenced (it's whatever
  // a fetcher chose to throw), so reading `.code` off it — even just to
  // check whether it's an own property — can itself throw (a throwing
  // getter, a Proxy `get` trap). If it does, that thrown value must not
  // replace the sanitized error being built around this call; fall through
  // to "unknown" instead of letting it propagate.
  try {
    if (typeof err !== "object" || err === null) return "unknown";
    // Own property only: an inherited `code` (e.g. via a shared prototype)
    // shouldn't classify as if this specific error carried it.
    if (!Object.hasOwn(err, "code")) return "unknown";

    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && Object.hasOwn(KNOWN_ERROR_CODES, code)) {
      return KNOWN_ERROR_CODES[code];
    }
  } catch {
    // Fall through to "unknown" below.
  }
  return "unknown";
}

/**
 * The one error shape this module throws for an upstream failure: a
 * message naming only the path and a coarse classification, and a `.code`
 * carrying that same classification (so a caller wrapping this error, like
 * createSecretReader wrapping vaultFetcher, reclassifies to the same result
 * instead of losing it). Never derived from, and never references, `err`
 * itself — nothing about the original error, however it is shaped, reaches
 * the result.
 */
function secretFetchError(prefix: string, path: string, err: unknown): Error {
  const errorClass = classifyError(err);
  const wrapped = new Error(`${prefix}: ${path} (${errorClass})`);
  (wrapped as Error & { code?: string }).code = errorClass;
  return wrapped;
}

export function createSecretReader(fetcher: SecretFetcher, ttlMs = DEFAULT_TTL_MS) {
  const cache = new Map<string, { value: string; expires: number }>();
  // De-dupes concurrent callers asking for the same path while a fetch is
  // already outstanding, so a cold cache under load doesn't hit Vault once
  // per caller. Entries are removed as soon as the fetch settles (success or
  // failure) so a rejection is never memoized here — only successful values
  // are cached, and only in `cache` above.
  const inFlight = new Map<string, Promise<string>>();

  return async function read(path: string): Promise<string> {
    const hit = cache.get(path);
    if (hit) {
      if (hit.expires > Date.now()) return hit.value;
      // Evict promptly on expiry rather than waiting for an overwrite that
      // may never come: a rotated-away secret should not linger in the
      // process heap just because nobody happened to re-request its path.
      cache.delete(path);
    }

    const pending = inFlight.get(path);
    if (pending) return pending;

    const promise = (async () => {
      let value: string | null;
      try {
        value = await fetcher(path);
      } catch (err) {
        // Never propagate the fetcher's own error: it may embed request or
        // response details — including, in a misbehaving fetcher, the
        // secret value itself. Classify and discard rather than surface it.
        throw secretFetchError("secret fetch failed", path, err);
      }

      // Fail closed and name the path, never the value — this message reaches logs.
      if (value === null) throw new Error(`secret not found: ${path}`);

      cache.set(path, { value, expires: Date.now() + ttlMs });
      return value;
    })();

    inFlight.set(path, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(path);
    }
  };
}

/**
 * Reads Supabase Vault. Secrets are named "<org>/<app>/<key>".
 *
 * Goes through the `public.read_vault_secret` SECURITY DEFINER function rather
 * than selecting `vault.decrypted_secrets` directly. That is not a style choice:
 * PostgREST exposes only `public` and `graphql_public`, so the direct read
 * answers `PGRST106 Invalid schema: vault` on every real Supabase project and
 * every tool call fails as `gateway_error`. Found in phase 1 manual verification
 * (step 5) — the plan specified the direct read and no automated test could
 * catch it, because the whole path is mocked.
 *
 * The alternative fix — adding `vault` to the project's exposed schemas — was
 * rejected: it publishes the decrypted-secrets view on the public Data API
 * surface, one grant mistake away from the internet, to save a function.
 */
export const vaultFetcher: SecretFetcher = async (path) => {
  // `createAdminClient()` only ever fails on missing/misconfigured
  // environment variables or an unexpected client shape — it never touches
  // a secret's value — so it is left outside the try below and its errors
  // propagate as-is instead of being mislabeled as a Vault read failure.
  const supabase = createAdminClient();

  try {
    const { data, error } = await supabase.rpc("read_vault_secret", { p_name: path });

    if (error) throw error;
    return (data as string | null) ?? null;
  } catch (err) {
    // Narrowed to just the query: a Postgrest error, a network exception, or
    // a body-parse failure can all embed response content, so classify and
    // discard rather than surface it.
    throw secretFetchError("vault read failed", path, err);
  }
};
