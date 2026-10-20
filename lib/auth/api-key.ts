import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Principal } from "@/lib/types";
import { ORG_SLUG_CHARS, isValidOrgSlug } from "@/lib/policy/slug";

export interface KeyRow {
  hash: string;
  org_id: string;
  org_slug: string;
  user_id: string;
  revoked_at: string | null;
  /**
   * NULL for a manual API key — those do not expire. Set for an OAuth access
   * token (`source = 'oauth'`). A non-null value that does not parse is
   * treated as expired: an unreadable expiry must fail closed, never be
   * skipped as if the column were absent.
   */
  expires_at: string | null;
  /** Optional only for older/injected test doubles; production rows always select it. */
  source?: "manual" | "oauth";
  /** Required and non-empty for every live OAuth row; null for manual keys. */
  oauth_resource?: string | null;
}

export interface AuthDeps {
  lookup(prefix: string): Promise<KeyRow | null>;
  rolesFor(userId: string, orgId: string): Promise<string[]>;
  /**
   * S4 (Task 12 final review): stamps `api_keys.last_used_at` for a key that just
   * authenticated successfully. `last_used_at` is declared in the migration and the spec, but
   * nothing ever wrote it — permanently NULL, with no way for an operator to tell a live key
   * from a dormant one before revoking it. Optional so an existing test double that predates
   * this need not supply one; `route-deps.ts`'s real `dbDeps()` always does. Called
   * fire-and-forget from `authenticateApiKey`'s perspective (awaited there, but any failure is
   * swallowed) — a write failure here must never turn a successful authentication into a
   * failed one.
   */
  touch?(prefix: string): Promise<void>;
}

const PREFIX_BYTES = 6;
const SECRET_BYTES = 24;

const KEY_RE = new RegExp(`^(kngw_[${ORG_SLUG_CHARS}]+_[0-9a-f]+)\\.[A-Za-z0-9_-]+$`);

export function generateApiKey(orgSlug: string): { key: string; prefix: string; hash: string } {
  if (!isValidOrgSlug(orgSlug)) {
    // Throw loudly here rather than silently minting a key that can never
    // authenticate: this is the only moment a bad slug is caught before it
    // becomes a customer-facing, unloggable 401.
    throw new Error(
      `generateApiKey: org slug ${JSON.stringify(orgSlug)} contains characters outside [${ORG_SLUG_CHARS}] and would not round-trip through parseKey`
    );
  }
  const prefix = `kngw_${orgSlug}_${randomBytes(PREFIX_BYTES).toString("hex")}`;
  const key = `${prefix}.${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return { key, prefix, hash: hashKey(key) };
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function parseKey(key: string): { prefix: string } | null {
  const m = KEY_RE.exec(key);
  return m ? { prefix: m[1] } : null;
}

/**
 * Resolves a bearer key to a Principal, or `null` when the key does not
 * authenticate (malformed, unknown prefix, revoked, hash mismatch, or a
 * resolved row with an unusable `org_slug`).
 *
 * Infrastructure failures are NOT represented as `null`: if `deps.lookup` or
 * `deps.rolesFor` rejects (e.g. a database/connection error), this
 * function's returned promise rejects too, and that rejection may carry
 * infrastructure detail (e.g. a connection string) that must never reach a
 * client response or an unguarded log line. Callers must handle both
 * outcomes -- `null` means "not authenticated"; a thrown/rejected call means
 * "could not determine" and needs its own try/catch, not a `if (!p)` check.
 */
export async function authenticateApiKey(key: string, deps: AuthDeps): Promise<Principal | null> {
  const parsed = parseKey(key);
  if (!parsed) return null;

  const row = await deps.lookup(parsed.prefix);
  if (!row || row.revoked_at) return null;
  if (isExpired(row.expires_at)) return null;
  if (!constantTimeEquals(hashKey(key), row.hash)) return null;
  // A legacy or corrupt OAuth row without an audience must fail closed. The
  // migration revokes legacy live OAuth rows, while this runtime check keeps
  // the invariant intact if a row is ever written outside the normal issuer.
  if (row.source === "oauth" &&
      (typeof row.oauth_resource !== "string" || row.oauth_resource.length === 0)) {
    return null;
  }
  // `org_id` is a NOT NULL FK to organizations(id), so a legitimately
  // resolved row always has a slug matching the same charset generation
  // enforces. A slug outside that charset (empty, whitespace, or anything
  // else `ORG_SLUG_RE` rejects) means the join that produced this row
  // failed silently (Task 11's `dbDeps` falls back to "" rather than
  // throwing) -- treat that as an authentication failure rather than
  // minting a Principal with an org identity no real organization has.
  //
  // The explicit `typeof` check matters even though `KeyRow.org_slug` is
  // typed `string`: that's a compile-time promise only, and this value
  // crosses an unenforced DB/JSON boundary. `RegExp.prototype.test`
  // coerces its argument to a string, so without this check a failed join
  // that yields `null` (a JSON `null` from a missing PostgREST relation) or
  // `undefined` (an optional-chained access with no `?? ""`) would
  // stringify to "null"/"undefined" -- both of which match the charset --
  // and authenticate.
  if (!isValidOrgSlug(row.org_slug)) return null;

  const principal: Principal = {
    userId: row.user_id,
    orgId: row.org_id,
    orgSlug: row.org_slug,
    roles: await deps.rolesFor(row.user_id, row.org_id),
    oauthResource: row.source === "oauth" ? row.oauth_resource! : null,
  };

  // S4: only reached once every check above has passed — a genuinely successful
  // authentication, not merely a resolved-but-rejected row (revoked, hash mismatch, bad
  // org_slug all return before this point). A failure to stamp `last_used_at` must never turn
  // this into a failed authentication: it's an operational nicety (letting an operator tell a
  // live key from a dormant one), not a security check.
  if (deps.touch) {
    try {
      await deps.touch(parsed.prefix);
    } catch {
      // Swallowed deliberately — see the doc comment on `AuthDeps.touch`.
    }
  }

  return principal;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * NULL means "never expires" — the manual-API-key case, and the reason this
 * is a helper rather than an inline comparison. Any non-null value that does
 * not parse to a finite timestamp is treated as EXPIRED rather than ignored:
 * a corrupt or half-written expiry must deny access, not silently grant an
 * unbounded one.
 */
function isExpired(expiresAt: string | null): boolean {
  if (expiresAt === null) return false;
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return true;
  return t <= Date.now();
}
