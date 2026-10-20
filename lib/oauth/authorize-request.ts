import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirectUriMatches } from "@/lib/oauth/clients";
import { parseResource } from "@/lib/oauth/resource";

/**
 * Validation shared by the two halves of the authorization endpoint: the
 * consent page (`app/oauth/authorize/page.tsx`, GET) and the decision handler
 * (`app/oauth/authorize/decision/route.ts`, POST).
 *
 * These lived as two hand-copied blocks and had already drifted — the GET side
 * rejected a missing `client_id`/`redirect_uri`, the POST side didn't. Both
 * halves must agree, because the POST side is what mints a code: anything the
 * consent screen refuses to render must also be refused on submit, or the
 * screen's checks are decorative.
 */

/** The eight query/form fields the authorization endpoint reads. */
export const AUTHORIZE_PARAM_KEYS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "state",
  "resource",
] as const;

export type AuthorizeParams = Record<
  (typeof AUTHORIZE_PARAM_KEYS)[number],
  string
>;

/**
 * Why a request was refused. A closed set rather than free text because the
 * POST handler passes it through a redirect: `?code=unknown_client` is looked
 * up in `AUTHORIZE_ERRORS`, so nobody can plant arbitrary copy — phishing
 * instructions, a fake support number — on a page carrying our branding.
 */
export type AuthorizeErrorCode =
  | "bad_response_type"
  | "missing_client_id"
  | "missing_redirect_uri"
  | "bad_code_challenge"
  | "missing_resource"
  | "resource_mismatch"
  | "unknown_client"
  | "client_disabled"
  | "bad_redirect_uri"
  | "code_issue_failed";

export const AUTHORIZE_ERRORS: Record<
  AuthorizeErrorCode,
  { title: string; detail: string }
> = {
  bad_response_type: {
    title: "Invalid request",
    detail:
      "This app asked for a response type this gateway doesn't support. Only the authorization code flow (response_type=code) is available.",
  },
  missing_client_id: {
    title: "Invalid request",
    detail: "The request arrived without a client_id, so there's no app to authorize.",
  },
  missing_redirect_uri: {
    title: "Invalid request",
    detail:
      "The request arrived without a redirect_uri, so there's nowhere to send you back to.",
  },
  bad_code_challenge: {
    title: "Invalid request",
    detail:
      "This gateway requires PKCE with SHA-256 (code_challenge_method=S256). The request didn't include a valid challenge.",
  },
  missing_resource: {
    title: "Invalid request",
    detail:
      "This app did not say which workspace it wants access to, so there is nothing to authorize.",
  },
  resource_mismatch: {
    title: "Invalid request",
    detail:
      "The resource this app named isn't this gateway. Check that the app is pointed at the right MCP endpoint.",
  },
  unknown_client: {
    title: "Unknown app",
    detail:
      "This client_id isn't registered with the gateway. If the app registered itself previously, its registration may have been removed — reconnecting from the app should register it again.",
  },
  client_disabled: {
    title: "App disabled",
    detail:
      "An administrator has disabled this app's access to the gateway. Contact your gateway administrator if you think that's wrong.",
  },
  bad_redirect_uri: {
    title: "Redirect address not recognized",
    detail:
      "The address this app wants to be sent back to doesn't match what it registered. This is what a tampered authorization link looks like, so the gateway stops here rather than following it.",
  },
  code_issue_failed: {
    title: "Something went wrong",
    detail:
      "The gateway couldn't issue an authorization code. Nothing was granted — try connecting from the app again.",
  },
};

/** Client row fields both halves need; the consent screen shows the last two. */
export type AuthorizeClient = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  registered_at: string;
  disabled_at: string | null;
};

export type AuthorizeCheck =
  | { ok: true; client: AuthorizeClient; orgSlug: string; appSlug: string | null }
  | { ok: false; code: AuthorizeErrorCode };

/** Read the eight fields out of a query string or a form body. */
export function parseAuthorizeParams(
  source: Pick<URLSearchParams | FormData, "get">,
): AuthorizeParams {
  const out = {} as AuthorizeParams;
  for (const key of AUTHORIZE_PARAM_KEYS) {
    const raw = source.get(key);
    out[key] = typeof raw === "string" ? raw : "";
  }
  return out;
}

/**
 * Validate an authorization request and load its client.
 *
 * Every check here has to pass before the caller may redirect to
 * `redirect_uri` for any reason — including a denial. Redirecting on an
 * unvalidated `redirect_uri` would make the gateway an open redirector, which
 * is why the deny path shares this function rather than short-circuiting.
 */
export async function checkAuthorizeRequest(
  params: AuthorizeParams,
  issuer: string,
): Promise<AuthorizeCheck> {
  if (params.response_type !== "code") {
    return { ok: false, code: "bad_response_type" };
  }
  if (!params.client_id) return { ok: false, code: "missing_client_id" };
  if (!params.redirect_uri) return { ok: false, code: "missing_redirect_uri" };
  if (!params.code_challenge || params.code_challenge_method !== "S256") {
    return { ok: false, code: "bad_code_challenge" };
  }

  // RFC 8707 is mandatory in the MCP specification, and this gateway has one
  // resource per org — so `resource` is not optional here as it was in
  // the reference implementation's single-resource build. It is what tells us WHICH org the
  // client is asking for, and a code cannot be issued without one.
  if (!params.resource) return { ok: false, code: "missing_resource" };
  const parsed = parseResource(params.resource, issuer);
  if (!parsed) return { ok: false, code: "resource_mismatch" };

  const admin = createAdminClient();
  const { data } = await admin
    .from("oauth_clients")
    .select("client_id, client_name, redirect_uris, registered_at, disabled_at")
    .eq("client_id", params.client_id)
    .maybeSingle();
  if (!data) return { ok: false, code: "unknown_client" };

  const client = data as AuthorizeClient;
  if (client.disabled_at) return { ok: false, code: "client_disabled" };
  if (!redirectUriMatches(client.redirect_uris, params.redirect_uri)) {
    return { ok: false, code: "bad_redirect_uri" };
  }
  return { ok: true, client, orgSlug: parsed.orgSlug, appSlug: parsed.appSlug };
}

/**
 * Build a redirect URL by adding `extras` to whatever query string `baseUrl`
 * already carries. Entries with an undefined or empty value are skipped, so we
 * don't emit `state=` when the client sent no state.
 */
export function appendQueryParams(
  baseUrl: string,
  extras: Record<string, string | undefined>,
): string {
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(extras)) {
    if (v === undefined || v === "") continue;
    url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * Whether this signed-in user may grant access to this org, and what they
 * hold there.
 *
 * This is the check that stops a signed-in user from one customer minting a
 * token for another. It runs BEFORE any code is issued, on both the GET
 * (consent render) and POST (decision) halves — the screen's check would be
 * decorative if the submit path did not repeat it.
 *
 * Requires BOTH a membership and at least one role assignment: a membership
 * with no roles grants no tools, so consenting to it would produce a token
 * that can do nothing while looking to the user like access was granted.
 */
export async function resolveOrgAccess(
  userId: string,
  orgSlug: string,
): Promise<{ ok: true; orgId: string; roles: string[] } | { ok: false }> {
  const admin = createAdminClient();
  const { data: org } = await admin
    .from("organizations").select("id").eq("slug", orgSlug).maybeSingle();
  if (!org) return { ok: false };
  const orgId = (org as { id: string }).id;

  const { data: membership } = await admin
    .from("memberships").select("user_id").eq("user_id", userId).eq("org_id", orgId).maybeSingle();
  if (!membership) return { ok: false };

  const { data: roleRows } = await admin
    .from("role_assignments").select("role").eq("user_id", userId).eq("org_id", orgId);
  const roles = (roleRows ?? []).map((r) => r.role as string);
  if (roles.length === 0) return { ok: false };

  return { ok: true, orgId, roles };
}
