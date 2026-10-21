import "server-only";
import { headers } from "next/headers";
import { canonicalOrigin } from "@/lib/http/canonical-host";

/**
 * Derive a bare origin from proxy headers. Shared by `issuerFromRequest`
 * (route handlers, which hold a NextRequest) and `originFromHeaders`
 * (Server Actions and Server Components, which reach headers through
 * `next/headers` instead). One implementation so a route handler and an
 * action can never disagree about what origin this deployment is serving.
 */
export function originFromHeaderPair(
  proto: string | null,
  host: string | null,
): string {
  return `${proto ?? "https"}://${host}`;
}

/**
 * The origin serving the current request, for a Server Action or Server
 * Component.
 *
 * Deliberately NOT read from an environment variable. This repo has no
 * NEXT_PUBLIC_* origin on purpose — Next inlines those at build time, and
 * `next build` runs inside the Docker image build where no Cloud Run
 * environment exists, so the value would bake in as `undefined` (the same
 * reasoning `lib/supabase/server.ts` records for its Supabase keys). Reading
 * the proxy headers per request also means a custom domain works with no code
 * change.
 */
export async function originFromHeaders(): Promise<string> {
  const h = await headers();
  return originFromHeaderPair(
    h.get("x-forwarded-proto"),
    h.get("x-forwarded-host") ?? h.get("host"),
  );
}

/**
 * The origin to put in a link the gateway emails (invites, password resets).
 * `CANONICAL_ORIGIN` when it is set, so a request carrying a forged
 * `X-Forwarded-Host` cannot point a genuine reset email at the attacker's
 * host. Falls back to the request's own origin only when it is unset, which
 * is fine for local development; set it in every deployment. Supabase's
 * redirect allowlist is the second line of defense and must list exact
 * origins, never a wildcard host.
 */
export async function emailLinkOrigin(): Promise<string> {
  return canonicalOrigin() ?? (await originFromHeaders());
}
