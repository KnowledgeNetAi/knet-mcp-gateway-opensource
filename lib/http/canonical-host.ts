/**
 * The public origin people should see, from `CANONICAL_ORIGIN` (e.g.
 * `https://gateway.example.com`). A platform host (`*.run.app`,
 * `*.vercel.app`, …) usually serves the same app, but a page opened there leaks
 * that host into everything built from the request origin: an invite sent from
 * the admin page carries that host in its `redirectTo`, and the login cookie is
 * scoped to the wrong host. Unset, nothing is redirected.
 */
export function canonicalOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.CANONICAL_ORIGIN?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Paths that must keep answering on whatever host the client was configured
 * with. An MCP connector registered against the platform host holds tokens whose
 * `resource` is bound to that host's issuer (`lib/mcp/handler.ts` compares
 * them), its OAuth flow validates `resource` against the host serving
 * `/oauth/authorize`, and machine clients don't reliably follow redirects.
 */
const MACHINE_PREFIXES = ["/mcp", "/oauth", "/.well-known", "/plugins"];

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Where a request on a non-canonical host should be sent, or null to serve it
 * in place. Only browser page loads (GET/HEAD) move; a POST — a Server Action
 * submitted from an already-open tab on the platform host — is left alone
 * rather than turned into a redirect the form can't follow. Local development
 * hosts are never redirected.
 */
export function canonicalRedirect(input: {
  method: string;
  host: string | null;
  pathname: string;
  search: string;
  canonical: string | null;
}): string | null {
  const { method, host, pathname, search, canonical } = input;
  if (!canonical || !host) return null;
  const hostname = host.toLowerCase().replace(/:\d+$/, "");
  if (LOCAL_HOSTS.has(hostname) || hostname === new URL(canonical).hostname) return null;
  if (method !== "GET" && method !== "HEAD") return null;
  if (MACHINE_PREFIXES.some((p) => underPrefix(pathname, p))) return null;
  // The login page mid-OAuth (`?next=/oauth/authorize…`) belongs to the
  // connector's flow, so it stays on the host that flow started on.
  if (pathname === "/login") {
    const next = new URLSearchParams(search).get("next") ?? "";
    if (underPrefix(next.split("?")[0], "/oauth")) return null;
  }
  return `${canonical}${pathname}${search}`;
}
