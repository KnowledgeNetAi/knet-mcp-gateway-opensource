import { describe, it, expect } from "vitest";
import { canonicalOrigin, canonicalRedirect } from "@/lib/http/canonical-host";

const PLATFORM = "mcp-gateway-abc123-uc.a.run.app";
const CANONICAL = "https://gateway.example.com";
const at = (
  pathname: string,
  opts: { method?: string; host?: string | null; search?: string; canonical?: string | null } = {},
) =>
  canonicalRedirect({
    method: opts.method ?? "GET",
    host: opts.host === undefined ? PLATFORM : opts.host,
    pathname,
    search: opts.search ?? "",
    canonical: opts.canonical === undefined ? CANONICAL : opts.canonical,
  });

describe("canonicalOrigin", () => {
  it("is null when unset, blank or not a URL", () => {
    expect(canonicalOrigin({})).toBeNull();
    expect(canonicalOrigin({ CANONICAL_ORIGIN: "  " })).toBeNull();
    expect(canonicalOrigin({ CANONICAL_ORIGIN: "gateway" })).toBeNull();
  });

  it("normalizes to an origin", () => {
    expect(canonicalOrigin({ CANONICAL_ORIGIN: "https://gateway.example.com/" })).toBe(CANONICAL);
  });
});

describe("canonicalRedirect", () => {
  it("moves browser pages on the platform host to the canonical origin, keeping path and query", () => {
    expect(at("/")).toBe("https://gateway.example.com/");
    expect(at("/admin/orgs/demo/members")).toBe("https://gateway.example.com/admin/orgs/demo/members");
    expect(at("/auth/confirm", { search: "?token_hash=abc&type=invite" }))
      .toBe("https://gateway.example.com/auth/confirm?token_hash=abc&type=invite");
    expect(at("/login", { method: "HEAD", search: "?next=%2Fadmin" })).toBe("https://gateway.example.com/login?next=%2Fadmin");
  });

  it("does nothing when no canonical origin is configured", () => {
    expect(at("/", { canonical: null })).toBeNull();
  });

  it("leaves the canonical host, localhost and a missing host alone", () => {
    expect(at("/", { host: "gateway.example.com" })).toBeNull();
    expect(at("/", { host: "localhost:3070" })).toBeNull();
    expect(at("/", { host: "127.0.0.1:3070" })).toBeNull();
    expect(at("/", { host: null })).toBeNull();
  });

  it("never redirects MCP, OAuth, discovery or plugin endpoints", () => {
    for (const p of ["/mcp/demo", "/mcp/demo/helloworld", "/oauth/authorize", "/oauth/token",
      "/oauth/register", "/.well-known/oauth-authorization-server", "/plugins/demo/x"]) {
      expect(at(p)).toBeNull();
    }
  });

  it("does not mistake a lookalike path for a machine prefix", () => {
    expect(at("/mcpx")).toBe("https://gateway.example.com/mcpx");
  });

  it("keeps the login page on the platform host while it is part of an OAuth flow", () => {
    expect(at("/login", { search: "?next=%2Foauth%2Fauthorize%3Fclient_id%3Dx" })).toBeNull();
  });

  it("does not redirect a POST (a Server Action from an open platform-host tab)", () => {
    expect(at("/login", { method: "POST" })).toBeNull();
  });
});
