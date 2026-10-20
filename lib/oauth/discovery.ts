import "server-only";
import { SUPPORTED_SCOPES } from "@/lib/oauth/scopes";
import { resourceUrl } from "@/lib/oauth/resource";

/**
 * RFC 8414 / RFC 9728 discovery metadata.
 *
 * `buildAuthorizationServerMetadata` is a direct port from the reference implementation.
 * `buildProtectedResourceMetadata` is adapted: the reference implementation is single-resource
 * (`resource` hardcoded to `<issuer>/mcp`), while this gateway has one
 * resource per org and per (org, app) — see `lib/oauth/resource.ts`.
 */

function normalize(issuer: string): string {
  return issuer.replace(/\/$/, "");
}

export type AsMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
};

export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
};

/**
 * Build RFC 8414 Authorization Server Metadata.
 *
 * `issuer` must be a bare origin (`scheme://host[:port]`). No path, query, or
 * fragment — those would be silently propagated into endpoint URLs.
 */
export function buildAuthorizationServerMetadata(issuer: string): AsMetadata {
  const i = normalize(issuer);
  return {
    issuer: i,
    authorization_endpoint: `${i}/oauth/authorize`,
    token_endpoint: `${i}/oauth/token`,
    registration_endpoint: `${i}/oauth/register`,
    revocation_endpoint: `${i}/oauth/revoke`,
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

/**
 * Build RFC 9728 Protected Resource Metadata for one resource — an org, or an
 * (org, app) pair. `issuer` must be a bare origin; the resource URL is
 * derived via `resourceUrl` (RFC 8707).
 */
export function buildProtectedResourceMetadata(
  issuer: string,
  orgSlug: string,
  appSlug: string | null,
): ProtectedResourceMetadata {
  const i = normalize(issuer);
  return {
    resource: resourceUrl(i, orgSlug, appSlug),
    authorization_servers: [i],
    bearer_methods_supported: ["header"],
    scopes_supported: [...SUPPORTED_SCOPES],
  };
}
