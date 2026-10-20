import { describe, it, expect } from "vitest";
import {
  validateRedirectUris,
  redirectUriMatches,
  generateClientId,
  validateGrantTypes,
} from "@/lib/oauth/clients";

describe("validateRedirectUris", () => {
  it("accepts https URIs", () => {
    expect(validateRedirectUris(["https://claude.ai/api/mcp/auth_callback"]))
      .toEqual({ ok: true });
  });

  it("accepts http://localhost (any port, any path)", () => {
    expect(validateRedirectUris(["http://localhost:3000/cb"])).toEqual({ ok: true });
    expect(validateRedirectUris(["http://localhost/cb"])).toEqual({ ok: true });
    expect(validateRedirectUris(["http://127.0.0.1:8080/x"])).toEqual({ ok: true });
  });

  it("rejects http for non-localhost hosts", () => {
    expect(validateRedirectUris(["http://example.com/cb"]))
      .toEqual({ ok: false, error: "invalid_redirect_uri" });
  });

  it("rejects empty array", () => {
    expect(validateRedirectUris([]))
      .toEqual({ ok: false, error: "invalid_redirect_uri" });
  });

  it("rejects malformed URIs", () => {
    expect(validateRedirectUris(["not a url"]))
      .toEqual({ ok: false, error: "invalid_redirect_uri" });
  });

  it("rejects URIs with fragment (RFC 6749 §3.1.2)", () => {
    expect(validateRedirectUris(["https://claude.ai/cb#frag"]))
      .toEqual({ ok: false, error: "invalid_redirect_uri" });
  });

  it("rejects URIs with userinfo (user:pass@host)", () => {
    expect(validateRedirectUris(["https://user:pass@claude.ai/cb"]))
      .toEqual({ ok: false, error: "invalid_redirect_uri" });
    expect(validateRedirectUris(["http://user@localhost/cb"]))
      .toEqual({ ok: false, error: "invalid_redirect_uri" });
  });

  it("accepts http://[::1] for IPv6 loopback", () => {
    expect(validateRedirectUris(["http://[::1]:8080/cb"])).toEqual({ ok: true });
  });

  it("rejects more than 5 redirect_uris", () => {
    const uris = Array.from({ length: 6 }, (_, i) => `https://example.com/cb${i}`);
    expect(validateRedirectUris(uris))
      .toEqual({ ok: false, error: "invalid_redirect_uri" });
  });

  it("rejects URIs longer than 2048 chars", () => {
    const long = "https://example.com/" + "a".repeat(2030);
    expect(validateRedirectUris([long]))
      .toEqual({ ok: false, error: "invalid_redirect_uri" });
  });
});

describe("redirectUriMatches", () => {
  it("exact-match equality (not prefix)", () => {
    const registered = ["https://claude.ai/api/mcp/auth_callback"];
    expect(redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback"))
      .toBe(true);
    expect(redirectUriMatches(registered, "https://claude.ai/api/mcp/auth_callback?x=1"))
      .toBe(false);
    expect(redirectUriMatches(registered, "https://claude.ai/"))
      .toBe(false);
  });
});

describe("generateClientId", () => {
  it("starts with oc_ and is unique per call", () => {
    const a = generateClientId();
    const b = generateClientId();
    expect(a).toMatch(/^oc_[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
});

describe("validateGrantTypes", () => {
  it("accepts authorization_code and refresh_token", () => {
    expect(validateGrantTypes(["authorization_code", "refresh_token"])).toEqual({ ok: true });
  });

  it("rejects unknown grant types", () => {
    expect(validateGrantTypes(["password"]))
      .toEqual({ ok: false, error: "invalid_client_metadata" });
  });

  it("defaults are accepted when undefined", () => {
    expect(validateGrantTypes(undefined)).toEqual({ ok: true });
  });

  it("rejects empty array (vs undefined which uses defaults)", () => {
    expect(validateGrantTypes([]))
      .toEqual({ ok: false, error: "invalid_client_metadata" });
  });

  it("rejects more than 4 grant_types", () => {
    expect(validateGrantTypes(["a","b","c","d","e"]))
      .toEqual({ ok: false, error: "invalid_client_metadata" });
  });
});
