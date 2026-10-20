import "server-only";
import { randomBytes } from "node:crypto";

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata" };

export function generateClientId(): string {
  return `oc_${randomBytes(16).toString("base64url")}`;
}

function isLocalhost(hostname: string): boolean {
  // new URL().hostname returns IPv6 hosts wrapped in brackets, e.g. "[::1]".
  // Strip them for comparison.
  const stripped = hostname.replace(/^\[|\]$/g, "");
  return stripped === "localhost" || stripped === "127.0.0.1" || stripped === "::1";
}

export function validateRedirectUris(uris: string[] | undefined): ValidationResult {
  if (!uris || uris.length === 0) {
    return { ok: false, error: "invalid_redirect_uri" };
  }
  if (uris.length > 5) {
    return { ok: false, error: "invalid_redirect_uri" };
  }
  for (const uri of uris) {
    if (uri.length > 2048) {
      return { ok: false, error: "invalid_redirect_uri" };
    }
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return { ok: false, error: "invalid_redirect_uri" };
    }
    // RFC 6749 §3.1.2 — fragments forbidden in redirect URIs.
    if (parsed.hash) return { ok: false, error: "invalid_redirect_uri" };
    // Reject userinfo (user:pass@host) — phishing vector and breaks exact-match.
    if (parsed.username || parsed.password) {
      return { ok: false, error: "invalid_redirect_uri" };
    }
    if (parsed.protocol === "https:") continue;
    if (parsed.protocol === "http:" && isLocalhost(parsed.hostname)) continue;
    return { ok: false, error: "invalid_redirect_uri" };
  }
  return { ok: true };
}

export function redirectUriMatches(registered: string[], candidate: string): boolean {
  return registered.includes(candidate);
}

const SUPPORTED_GRANTS = new Set(["authorization_code", "refresh_token"]);

export function validateGrantTypes(types: string[] | undefined): ValidationResult {
  if (types === undefined) return { ok: true };
  if (types.length === 0) {
    return { ok: false, error: "invalid_client_metadata" };
  }
  if (types.length > 4) {
    return { ok: false, error: "invalid_client_metadata" };
  }
  for (const t of types) {
    if (!SUPPORTED_GRANTS.has(t)) {
      return { ok: false, error: "invalid_client_metadata" };
    }
  }
  return { ok: true };
}
