import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashAuthCode, verifyPkceS256 } from "@/lib/oauth/codes";
import { issueOauthTokens, rotateRefreshToken } from "@/lib/oauth/tokens";
import { issuerFromRequest } from "@/lib/oauth/issuer";
import { parseResource, resourceUrl } from "@/lib/oauth/resource";
import { sweepExpiredCodes, sweepUnusedClients } from "@/lib/oauth/cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Spec decision 4: 30 days, matching the reference implementation. Revocation is instant
// regardless of TTL -- every request re-reads the api_keys row and checks
// revoked_at -- so the usual short-lived-token argument doesn't carry the
// weight it would for a self-contained, unrevocable token. Do not shorten
// this "for safety"; see the design doc §7 for the recorded trade-off.
const ACCESS_TOKEN_TTL_SEC = 60 * 60 * 24 * 30;

function tokenError(code: string, description?: string, status = 400) {
  return NextResponse.json(
    { error: code, ...(description ? { error_description: description } : {}) },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";
  const form = ct.includes("application/x-www-form-urlencoded")
    ? await req.formData()
    : new URLSearchParams(await req.text());
  const get = (k: string) => String(form.get(k) ?? "");

  const grant_type = get("grant_type");
  const supabase = createAdminClient();

  if (grant_type === "authorization_code") {
    const code = get("code");
    const client_id = get("client_id");
    const redirect_uri = get("redirect_uri");
    const code_verifier = get("code_verifier");
    const resource = get("resource");
    if (!code || !client_id || !redirect_uri || !code_verifier || !resource) {
      return tokenError("invalid_request", "missing required params");
    }

    // RFC 8707 is mandatory on both authorize and token in the MCP
    // specification. parseResource validates shape/origin/charset only -- it
    // never consults the org catalog -- so this rejects a malformed
    // `resource` before the database is ever touched.
    const issuer = issuerFromRequest(req);
    const parsedResource = parseResource(resource, issuer);
    if (!parsedResource) {
      return tokenError("invalid_grant", "resource invalid");
    }

    const { data: row } = await supabase
      .from("oauth_authorization_codes")
      .select(
        "code_hash, client_id, user_id, org_id, redirect_uri, scopes, code_challenge, resource, expires_at, consumed_at, organizations(slug)",
      )
      .eq("code_hash", hashAuthCode(code))
      .maybeSingle();
    if (!row) return tokenError("invalid_grant", "unknown code");
    const r = row as unknown as {
      code_hash: string;
      client_id: string;
      user_id: string;
      org_id: string;
      redirect_uri: string;
      scopes: string[];
      code_challenge: string;
      resource: string | null;
      expires_at: string;
      consumed_at: string | null;
      organizations: { slug: string } | null;
    };
    if (r.consumed_at) return tokenError("invalid_grant", "code already used");
    if (new Date(r.expires_at).getTime() <= Date.now()) {
      return tokenError("invalid_grant", "code expired");
    }
    if (r.client_id !== client_id) return tokenError("invalid_grant", "client mismatch");
    // A code issued in the seconds before its client was disabled must not
    // still mint tokens (the disable trigger revokes only existing keys).
    const { data: client } = await supabase
      .from("oauth_clients")
      .select("disabled_at")
      .eq("client_id", r.client_id)
      .maybeSingle();
    if (!client || (client as { disabled_at: string | null }).disabled_at) {
      return tokenError("invalid_grant", "client disabled");
    }
    if (r.redirect_uri !== redirect_uri) {
      return tokenError("invalid_grant", "redirect_uri mismatch");
    }
    if (!verifyPkceS256(code_verifier, r.code_challenge)) {
      return tokenError("invalid_grant", "PKCE verification failed");
    }
    // `resource` is mandatory in the MCP specification, and the consent
    // screen never issues a code without one -- a null here means something
    // upstream is broken, not a legacy code to grandfather in. Reject rather
    // than skip the check. The match against the caller-supplied `resource`
    // must be exact: this is what makes step 6 (the org-mismatch check in
    // lib/mcp/handler.ts) a real audience validation rather than a formality.
    if (!r.resource) return tokenError("invalid_grant", "code missing resource");
    if (r.resource !== resource) return tokenError("invalid_grant", "resource mismatch");

    const orgSlug = r.organizations?.slug;
    if (!orgSlug) return tokenError("invalid_grant", "org not found");

    const { data: consumed, error: consumeErr } = await supabase
      .from("oauth_authorization_codes")
      .update({ consumed_at: new Date().toISOString() })
      .eq("code_hash", r.code_hash)
      .is("consumed_at", null)
      .select("code_hash");
    if (consumeErr || !consumed || consumed.length === 0) {
      return tokenError("invalid_grant", "code already used");
    }

    const issued = await issueOauthTokens(supabase, {
      userId: r.user_id,
      orgId: r.org_id,
      orgSlug,
      clientId: r.client_id,
      scopes: r.scopes,
      // `parseResource` deliberately accepts a harmless trailing slash. Store
      // one canonical spelling so the later exact audience comparison does
      // not reject a token solely because the authorize request used it.
      resource: resourceUrl(issuer, parsedResource.orgSlug, parsedResource.appSlug),
      ttlSeconds: ACCESS_TOKEN_TTL_SEC,
    });

    console.log(
      JSON.stringify({
        event: "token.issued.auth_code",
        client_id: r.client_id,
        org_id: r.org_id,
        access_prefix: issued.access_token.split(".")[0],
        scopes: r.scopes,
      }),
    );

    // Opportunistic sweep (spec §6): the gateway has no worker daemon, and a
    // 60-second-TTL table doesn't justify Cloud Scheduler. Fire-and-forget --
    // a sweep failure must never fail a token exchange.
    void sweepExpiredCodes(supabase).catch(() => {});
    void sweepUnusedClients(supabase).catch(() => {});

    return NextResponse.json(
      {
        access_token: issued.access_token,
        token_type: "Bearer",
        expires_in: issued.expires_in,
        refresh_token: issued.refresh_token,
        scope: r.scopes.join(" "),
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  if (grant_type === "refresh_token") {
    const refresh_token = get("refresh_token");
    const client_id = get("client_id");
    if (!refresh_token || !client_id) {
      return tokenError("invalid_request", "missing required params");
    }
    const result = await rotateRefreshToken(supabase, {
      refreshToken: refresh_token,
      clientId: client_id,
      ttlSeconds: ACCESS_TOKEN_TTL_SEC,
    });
    if (result.kind === "error") {
      console.warn(
        JSON.stringify({ event: "token.refresh_rejected", client_id, code: result.code }),
      );
      return tokenError(result.code, "refresh failed");
    }

    console.log(
      JSON.stringify({
        event: "token.issued.refresh",
        client_id,
        access_prefix: result.access_token.split(".")[0],
      }),
    );

    // Opportunistic sweep (spec §6) -- see the comment in the authorization_code
    // branch above.
    void sweepExpiredCodes(supabase).catch(() => {});

    return NextResponse.json(
      {
        access_token: result.access_token,
        token_type: "Bearer",
        expires_in: result.expires_in,
        refresh_token: result.refresh_token,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  return tokenError("unsupported_grant_type", `grant_type=${grant_type}`);
}
