import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { describeScope } from "@/lib/oauth/scopes";
import { getCatalog } from "@/lib/mcp/catalog";
import { computeGrant } from "@/lib/policy/grants";
import {
  AUTHORIZE_PARAM_KEYS,
  appendQueryParams,
  checkAuthorizeRequest,
  parseAuthorizeParams,
  resolveOrgAccess,
  type AuthorizeParams,
} from "@/lib/oauth/authorize-request";
import { AuthorizeError } from "@/components/auth/authorize-error";
import { AuthFrame, AuthPanel, AuthSubmit, AuthLink, AuthNotice } from "@/components/auth/frame";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Derive the bare-origin URL (e.g. `https://<host>`) from the incoming
 * request headers inside this Server Component. Mirrors `issuerFromRequest`
 * (`lib/oauth/issuer.ts`) but reads the async `headers()` store instead of a
 * NextRequest, since a page component has no request object to read from.
 *
 * Inlined here rather than factored into a shared `lib/http/` module: this
 * task's file list does not include a new shared lib file, and this repo has
 * no equivalent one yet — see the identical inline helper in
 * `app/forgot-password/actions.ts`.
 */
async function originFromHeaders(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host");
  return `${proto}://${host}`;
}

/**
 * OAuth consent screen (RFC 6749 §4.1.1, GET half of the authorization
 * endpoint). The POST half — the decision the person makes here — lives at
 * `/oauth/authorize/decision`, because Next won't let a `page.tsx` and a
 * `route.ts` share one path. Only GET is spec-visible: `authorization_endpoint`
 * in the discovery document still points at `/oauth/authorize`.
 *
 * This is a page rather than a route handler returning HTML so that it
 * inherits the root layout — `globals.css` and the MCP Gateway shell. As a
 * standalone HTML document it would have neither, and a signed-in user would
 * go from a designed sign-in page to an unstyled one at the exact moment
 * they're being asked to grant access to their own data.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const params = parseAuthorizeParams(toSearchParams(sp));
  const issuer = await originFromHeaders();

  const check = await checkAuthorizeRequest(params, issuer);
  if (!check.ok) return <AuthorizeError code={check.code} />;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(resumeUrl(params))}`);
  }

  // The org-membership binding (spec §4). This is the check that stops a
  // signed-in user from one customer minting a token for another — it runs
  // here on the GET/render half, and is re-run, never trusted, on the POST
  // decision half before any code is issued.
  const access = await resolveOrgAccess(user.id, check.orgSlug);
  if (!access.ok) {
    return (
      <AuthFrame eyebrow="Authorize" title="Access denied">
        <AuthNotice tone="error" label="no workspace access">
          You do not have access to this workspace. Ask your gateway administrator
          to add you to it, then connect again.
        </AuthNotice>
        <div className="auth-links">
          <AuthLink href="/">Back</AuthLink>
        </div>
      </AuthFrame>
    );
  }

  // Consent copy is computed from the caller's actual grant (spec decision 7)
  // rather than rendered from the raw `scope` string, which means nothing to
  // the person clicking Allow. `computeGrant` is PER-APP and the catalog is a
  // Map keyed `${org}/${app}`, so gather this org's apps the way
  // `lib/mcp/handler.ts` already does and union across them.
  const entries = [...getCatalog().values()].filter(
    (e) => e.org === check.orgSlug && (check.appSlug === null || e.app === check.appSlug),
  );
  const toolNames = entries.flatMap((e) =>
    [...computeGrant(access.roles, e.roles, e.config.tools).tools].map((t) => `${e.app}_${t}`),
  );

  const scopes = params.scope.split(" ").filter(Boolean);
  const clientName = check.client.client_name;

  return (
    <AuthFrame
      eyebrow="Authorize"
      title={
        // A client picks its own `client_name` at registration, so this string
        // is untrusted and can run to 200 characters. React escapes it, so the
        // risk isn't injection — it's a name written to fill the viewport and
        // push Allow below the fold, or to bury a lookalike in a wall of text.
        // Step it down a size and cap it at three lines; the full value stays
        // in the title attribute for anyone who wants to read it.
        <span
          title={clientName}
          className={clientName.length > 32 ? "auth-client-name auth-client-name-clamp" : "auth-client-name"}
        >
          {clientName}
        </span>
      }
      lede={
        <>
          wants to run MCP Gateway tools as you. Apps choose their own name —
          the return address below is the part we verify.
        </>
      }
    >
      <AuthPanel>
        <dl className="auth-facts">
          <Fact label="Signed in as">{user.email ?? "(no email)"}</Fact>
          <Fact label="Workspace">{check.orgSlug}</Fact>
          <Fact label="Sends you back to" mono>
            {returnHost(params.redirect_uri)}
          </Fact>
          <Fact label="App registered">{relativeAge(check.client.registered_at)}</Fact>
        </dl>

        <div className="auth-permissions-label">Permissions</div>
        <ul className="auth-permissions">
          {toolNames.length > 0 ? (
            toolNames.map((t) => <Grant key={t}>{t}</Grant>)
          ) : scopes.length === 0 ? (
            <Grant>Basic gateway access</Grant>
          ) : (
            scopes.map((s) => <Grant key={s}>{describeScope(s)}</Grant>)
          )}
        </ul>

        <form action="/oauth/authorize/decision" method="post" className="auth-form">
          {AUTHORIZE_PARAM_KEYS.map((k) => (
            <input key={k} type="hidden" name={k} value={params[k]} />
          ))}
          <input type="hidden" name="decision" value="allow" />
          <AuthSubmit>Allow access</AuthSubmit>
        </form>
      </AuthPanel>

      <div className="auth-links">
        {/* Denial is a plain GET back to the client's validated redirect_uri —
            no state changes, so it needs no CSRF token or form post. */}
        <AuthLink
          external
          href={appendQueryParams(params.redirect_uri, {
            error: "access_denied",
            state: params.state || undefined,
          })}
        >
          Deny
        </AuthLink>
      </div>
    </AuthFrame>
  );
}

/** One label/value row in the facts list. */
function Fact({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="auth-fact">
      <dt className="auth-fact-label">{label}</dt>
      <dd className={mono ? "auth-fact-value auth-fact-value-mono" : "auth-fact-value"}>
        {children}
      </dd>
    </div>
  );
}

/** One permission the app is asking for. */
function Grant({ children }: { children: ReactNode }) {
  return (
    <li className="auth-permission">
      <span className="auth-permission-dot" aria-hidden />
      <span className="auth-permission-label">{children}</span>
    </li>
  );
}

/**
 * The host (and port) a successful authorization will hand the code to. This
 * is the one part of the request an app can't lie about — it has to match a
 * `redirect_uri` the app registered, and `validateRedirectUris` allows only
 * https or http-on-localhost — so it's what a person should actually read.
 */
function returnHost(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    // checkAuthorizeRequest matched this against a registered URI, and
    // registration parses it, so an unparseable value shouldn't reach here.
    return redirectUri;
  }
}

/**
 * Coarse relative age, computed server-side (no timezone involved). A client
 * registers itself moments before its first authorization, so "12 seconds ago"
 * is the normal first-connect reading, not a warning sign — what's worth
 * noticing is a *familiar* app that suddenly reads as newly registered.
 */
function relativeAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "moments ago";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** Normalize Next's searchParams object into a `.get()`-able shape. */
function toSearchParams(
  sp: Record<string, string | string[] | undefined>,
): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    // A repeated param (?scope=a&scope=b) arrives as an array. Take the first
    // rather than joining: OAuth params are single-valued, and a duplicate is
    // a malformed request whose second value we shouldn't silently honor.
    if (typeof v === "string") out.set(k, v);
    else if (Array.isArray(v) && v.length > 0) out.set(k, v[0]);
  }
  return out;
}

/**
 * The URL to come back to after signing in. Rebuilt from the eight known
 * params rather than echoing the original query string, so nothing unexpected
 * rides along through the login redirect.
 */
function resumeUrl(params: AuthorizeParams): string {
  const qs = new URLSearchParams();
  for (const k of AUTHORIZE_PARAM_KEYS) {
    if (params[k]) qs.set(k, params[k]);
  }
  return `/oauth/authorize?${qs.toString()}`;
}
