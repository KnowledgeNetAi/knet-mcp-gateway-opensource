import "server-only";
import { isValidOrgSlug } from "@/lib/policy/slug";

/**
 * RFC 8707 resource identifiers for this gateway, and the RFC 9728 metadata
 * URLs that describe them.
 *
 * the reference implementation, which this phase ports from, is single-resource: its
 * `buildProtectedResourceMetadata` hardcodes `<issuer>/mcp`. The gateway has
 * one resource per org and per (org, app), which is the whole reason this
 * module exists.
 */

/** App slugs come from committed directory names; same charset as an org. */
const APP_SLUG_OK = (v: string) => isValidOrgSlug(v);

const strip = (s: string) => s.replace(/\/+$/, "");

/** The canonical resource identifier for an org, or an (org, app) pair. */
export function resourceUrl(issuer: string, orgSlug: string, appSlug: string | null): string {
  const base = `${strip(issuer)}/mcp/${orgSlug}`;
  return appSlug ? `${base}/${appSlug}` : base;
}

/**
 * Where the protected-resource metadata for that identifier lives.
 *
 * RFC 9728 §3.1: "any terminating slash following the host component MUST be
 * removed before inserting /.well-known/ and the well-known URI path suffix
 * between the host component and the path" — so this is an INSERTION after the
 * origin, not an append to the path.
 */
export function resourceMetadataUrl(issuer: string, orgSlug: string, appSlug: string | null): string {
  const path = appSlug ? `/mcp/${orgSlug}/${appSlug}` : `/mcp/${orgSlug}`;
  return `${strip(issuer)}/.well-known/oauth-protected-resource${path}`;
}

/**
 * Parse a client-supplied `resource` back into (org, app), or null if it is
 * not a resource this gateway serves.
 *
 * Deliberately strict and deliberately SYNTACTIC: it validates shape, origin
 * and charset, and never consults the catalog. Checking existence here would
 * make a rejected `resource` an org-enumeration oracle, which phase 1's
 * "denials are indistinguishable" posture rules out. Whether the org actually
 * exists — and whether this user may reach it — is settled later, at consent,
 * against the signed-in user's memberships.
 */
export function parseResource(
  resource: string,
  issuer: string,
): { orgSlug: string; appSlug: string | null } | null {
  let url: URL;
  let base: URL;
  try {
    url = new URL(resource);
    base = new URL(issuer);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  // A canonical resource identifier carries neither, and accepting either
  // would let two spellings of "the same" resource diverge.
  if (url.hash || url.search) return null;

  const segments = strip(url.pathname).split("/").filter(Boolean);
  if (segments[0] !== "mcp") return null;
  if (segments.length < 2 || segments.length > 3) return null;

  const [, orgSlug, appSlug] = segments;
  if (!isValidOrgSlug(orgSlug)) return null;
  if (appSlug !== undefined && !APP_SLUG_OK(appSlug)) return null;

  return { orgSlug, appSlug: appSlug ?? null };
}
