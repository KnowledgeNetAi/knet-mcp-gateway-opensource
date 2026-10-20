import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateApiKey } from "@/lib/auth/api-key";

export type IssueInput = {
  userId: string;
  orgId: string;
  orgSlug: string;
  clientId: string;
  scopes: string[];
  resource: string;
  ttlSeconds: number;
};

export type IssueResult = {
  api_key_id: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

export type RotateInput = {
  refreshToken: string;
  clientId: string;
  ttlSeconds: number;
};

export type RotateResult =
  | (IssueResult & { kind: "ok" })
  | { kind: "error"; code: "invalid_grant" };

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * A refresh token is never presented to `authenticateApiKey` -- only to
 * `/oauth/token` -- so, unlike an access token, it has no natural
 * variable-length "prefix" to look it up by. This is the fixed slice length
 * used for both minting (`issueOauthTokens`) and lookup (`rotateRefreshToken`,
 * and `app/oauth/revoke/route.ts`), kept as one exported constant so the
 * three call sites cannot drift out of sync with each other.
 */
export const REFRESH_TOKEN_PREFIX_LEN = 16;

/**
 * OAuth access tokens are minted in the gateway's own API-key shape --
 * `kngw_<org>_<hex>.<secret>` -- and stored as `api_keys` rows (phase 2 spec,
 * decision 2).
 *
 * That is not cosmetic. `authenticateApiKey` then validates an OAuth token and
 * a manual key on ONE code path, and the token's org binding lives in the
 * token itself rather than only in a column: `parseKey` recovers the prefix,
 * the row carries `org_id`, and `lib/mcp/handler.ts`'s existing
 * `principal.orgSlug !== orgSlug` check becomes the audience validation the
 * MCP specification requires. A future code path cannot forget to scope a
 * token to an org, because an unscoped token is not a well-formed one.
 */
export async function issueOauthTokens(
  supabase: SupabaseClient,
  input: IssueInput,
): Promise<IssueResult> {
  const access = generateApiKey(input.orgSlug);
  // The refresh token is NOT key-shaped: it is never presented to
  // authenticateApiKey, only to /oauth/token, and giving it the same shape
  // would invite exactly that confusion.
  const refresh = `kngwr_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();

  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      org_id: input.orgId,
      user_id: input.userId,
      prefix: access.prefix,
      hash: access.hash,
      label: `oauth:${input.clientId}`,
      source: "oauth",
      oauth_client_id: input.clientId,
      expires_at: expiresAt,
      refresh_token_hash: sha256(refresh),
      refresh_token_prefix: refresh.slice(0, REFRESH_TOKEN_PREFIX_LEN),
      scopes: input.scopes,
      oauth_resource: input.resource,
    })
    .select("id")
    .single();
  if (error) throw new Error(`issueOauthTokens: ${error.message}`);
  if (!data) throw new Error("issueOauthTokens: insert returned no row");

  return {
    api_key_id: (data as { id: string }).id,
    access_token: access.key,
    refresh_token: refresh,
    expires_in: input.ttlSeconds,
  };
}

/**
 * Validates a refresh token, atomically revokes the issuing row, and mints a
 * new access/refresh pair bound to the same org.
 *
 * Returns `{ kind: "ok", ... }` on success or `{ kind: "error", code: "invalid_grant" }`
 * for any OAuth-protocol failure (unknown/revoked/replayed token, client
 * mismatch, lost rotation race, or a row whose org can no longer be
 * resolved).
 *
 * Throws on database errors during the issuance of the new pair (after the
 * old token has already been revoked). Callers should wrap in try/catch and
 * surface a 500 -- at that point the user is signed out and a fresh
 * authorize is needed.
 */
export async function rotateRefreshToken(
  supabase: SupabaseClient,
  input: RotateInput,
): Promise<RotateResult> {
  const { data: row, error } = await supabase
    .from("api_keys")
    // `organizations(slug)` is an embed across the `org_id` FK: `api_keys`
    // only stores the org's id, and `issueOauthTokens` needs the slug itself
    // to mint the new `kngw_<org>_...` token.
    .select("id, org_id, user_id, oauth_client_id, scopes, oauth_resource, revoked_at, organizations(slug)")
    .eq("refresh_token_prefix", input.refreshToken.slice(0, REFRESH_TOKEN_PREFIX_LEN))
    .eq("refresh_token_hash", sha256(input.refreshToken))
    .eq("source", "oauth")
    .maybeSingle();

  if (error || !row) return { kind: "error", code: "invalid_grant" };
  const r = row as unknown as {
    id: string;
    org_id: string;
    user_id: string;
    oauth_client_id: string;
    scopes: string[];
    oauth_resource: string | null;
    revoked_at: string | null;
    organizations: { slug: string } | null;
  };
  if (r.revoked_at) {
    // Spec decision 5: no refresh replay-chain invalidation. A replayed
    // refresh token -- one whose row is already revoked, because it was
    // rotated once already -- is rejected with invalid_grant and nothing
    // more. the reference implementation records the stronger behavior (invalidating the
    // entire chain on replay) as a future hardening step; that TODO is
    // preserved here, deliberately not implemented: at a 30-day rotation
    // cadence this is a path that would run roughly once a month and never
    // get meaningfully exercised.
    return { kind: "error", code: "invalid_grant" };
  }
  if (r.oauth_client_id !== input.clientId) {
    return { kind: "error", code: "invalid_grant" };
  }
  if (!r.oauth_resource) return { kind: "error", code: "invalid_grant" };
  const orgSlug = r.organizations?.slug;
  if (!orgSlug) return { kind: "error", code: "invalid_grant" };

  // Atomically: revoke old row, then issue new. If the revoke fails we don't
  // mint anything new. Two statements rather than one because supabase-js
  // doesn't expose a transaction primitive -- order matters: revoke first so
  // a crash between them leaves the user "signed out", not "with two live
  // tokens".
  //
  // The .select("id") forces supabase-js to surface the affected rowcount;
  // under concurrent rotation Postgres serializes the UPDATEs and the loser
  // matches 0 rows (since `revoked_at` is no longer NULL) -- without the
  // SELECT supabase-js silently returns success on 0-rows-affected, which
  // would let both callers fall through to issueOauthTokens and
  // double-mint.
  const { data: revoked, error: revokeErr } = await supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", r.id)
    .is("revoked_at", null)
    .select("id");
  if (revokeErr || !revoked || revoked.length === 0) {
    return { kind: "error", code: "invalid_grant" };
  }

  const issued = await issueOauthTokens(supabase, {
    userId: r.user_id,
    orgId: r.org_id,
    orgSlug,
    clientId: r.oauth_client_id,
    scopes: r.scopes,
    resource: r.oauth_resource,
    ttlSeconds: input.ttlSeconds,
  });

  return { kind: "ok", ...issued };
}
