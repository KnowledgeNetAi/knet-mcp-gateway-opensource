import "server-only";

/**
 * Supported OAuth scopes (RFC 6749 §3.3). Single source of truth — referenced
 * by the discovery JSON, the authorize handler, and the token handler. When
 * adding a new scope, update this tuple; downstream sites import it.
 */
export const SUPPORTED_SCOPES = ["mcp:gateway"] as const;

export type SupportedScope = typeof SUPPORTED_SCOPES[number];

/**
 * What `mcp:gateway` actually grants. One umbrella scope, because nothing
 * enforces scopes: neither /mcp nor /api/v1/* reads `api_keys.scopes`, so a
 * finer-grained taxonomy would be decorative until someone writes the checks.
 */
const GATEWAY_GRANT = "Run gateway tools on your behalf";

/**
 * Consent copy per scope. The authorize page renders these instead of the raw
 * token — `mcp:gateway` means nothing to the person clicking Allow.
 */
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "mcp:gateway": GATEWAY_GRANT,
};

/** Human-readable label for a requested scope; unknown scopes render as-is. */
export function describeScope(scope: string): string {
  return SCOPE_DESCRIPTIONS[scope] ?? scope;
}
