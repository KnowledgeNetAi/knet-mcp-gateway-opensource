import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateAuthCode, hashAuthCode, AUTH_CODE_TTL_MS } from "@/lib/oauth/codes";
import { issuerFromRequest } from "@/lib/oauth/issuer";
import {
  AUTHORIZE_PARAM_KEYS,
  appendQueryParams,
  checkAuthorizeRequest,
  parseAuthorizeParams,
  resolveOrgAccess,
  type AuthorizeErrorCode,
  type AuthorizeParams,
} from "@/lib/oauth/authorize-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The decision half of the authorization endpoint: what the Allow button on
 * `/oauth/authorize` posts to. Split out because Next can't host a `page.tsx`
 * and a `route.ts` at one path, and the consent screen has to be a page to
 * inherit the root layout. Nothing spec-visible moved — clients only ever GET
 * `/oauth/authorize`, which is still what discovery advertises.
 *
 * This stays a form POST to a route handler rather than a Server Action so the
 * response is a plain redirect to the client's `redirect_uri`; a Server Action
 * redirect is followed by Next's router, which is the wrong machinery for
 * handing a code to an external callback.
 */

function errorRedirect(req: NextRequest, code: AuthorizeErrorCode): NextResponse {
  const url = new URL("/oauth/authorize/error", issuerFromRequest(req));
  url.searchParams.set("code", code);
  // 303 so the browser turns the POST into a GET for the error page.
  return NextResponse.redirect(url, { status: 303 });
}

function originOk(req: NextRequest): boolean {
  // Browsers reliably send Origin on cross-site form-POSTs, so a mismatch
  // catches the CSRF case. Same-origin POSTs may omit Origin entirely
  // (older browsers / non-browser clients), so absent → allow.
  const origin = req.headers.get("origin");
  if (!origin) return true;
  return origin === issuerFromRequest(req);
}

/** Rebuild the consent URL so an expired session (or a denied org) can resume. */
function resumeUrl(req: NextRequest, params: AuthorizeParams): string {
  const url = new URL("/oauth/authorize", issuerFromRequest(req));
  for (const k of AUTHORIZE_PARAM_KEYS) {
    if (params[k]) url.searchParams.set(k, params[k]);
  }
  return url.pathname + url.search;
}

export async function POST(req: NextRequest) {
  if (!originOk(req)) {
    return new NextResponse("cross-origin POST rejected", { status: 403 });
  }

  const form = await req.formData();
  const params = parseAuthorizeParams(form);
  const decision = String(form.get("decision") ?? "");
  const issuer = issuerFromRequest(req);

  // Validate the client, redirect_uri and resource BEFORE any redirect to
  // redirect_uri. Both the allow and the deny branch depend on this: without
  // it, a POST carrying decision=deny and an arbitrary redirect_uri would
  // turn the gateway into an open redirector.
  const check = await checkAuthorizeRequest(params, issuer);
  if (!check.ok) return errorRedirect(req, check.code);

  // Only now is it safe to send the browser to redirect_uri.
  if (decision !== "allow") {
    return NextResponse.redirect(
      appendQueryParams(params.redirect_uri, {
        error: "access_denied",
        state: params.state || undefined,
      }),
    );
  }

  // If the session expired between rendering consent and this POST, bounce
  // through /login?next=… so the person can re-authenticate and resume rather
  // than hitting a dead end after clicking Allow.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(
      new URL(`/login?next=${encodeURIComponent(resumeUrl(req, params))}`, issuer),
      { status: 303 },
    );
  }

  // The org-membership binding (spec §4), re-run here rather than trusted from
  // the GET render: the consent screen's check would be decorative if the
  // submit path did not repeat it, since a POST can be sent directly without
  // ever loading the page. On failure: no code is issued and the browser is
  // never sent to redirect_uri — it bounces back to the consent GET, which
  // re-runs this same check and renders the access-denied screen.
  const access = await resolveOrgAccess(user.id, check.orgSlug);
  if (!access.ok) {
    return NextResponse.redirect(new URL(resumeUrl(req, params), issuer), { status: 303 });
  }

  const rawCode = generateAuthCode();
  const admin = createAdminClient();
  const { error: insErr } = await admin.from("oauth_authorization_codes").insert({
    code_hash: hashAuthCode(rawCode),
    client_id: params.client_id,
    user_id: user.id,
    org_id: access.orgId,
    redirect_uri: params.redirect_uri,
    scopes: params.scope.split(" ").filter(Boolean),
    code_challenge: params.code_challenge,
    code_challenge_method: "S256",
    resource: params.resource,
    expires_at: new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString(),
  });
  if (insErr) {
    console.error(JSON.stringify({ event: "authorize.error", message: insErr.message }));
    return errorRedirect(req, "code_issue_failed");
  }

  console.log(
    JSON.stringify({
      event: "authorize.issued",
      client_id: params.client_id,
      user_id: user.id,
      org_id: access.orgId,
      scopes: params.scope.split(" ").filter(Boolean),
    }),
  );

  return NextResponse.redirect(
    appendQueryParams(params.redirect_uri, {
      code: rawCode,
      state: params.state || undefined,
    }),
    { status: 302 },
  );
}
