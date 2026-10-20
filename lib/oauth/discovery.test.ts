import { describe, it, expect } from "vitest";
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from "@/lib/oauth/discovery";
import { SUPPORTED_SCOPES } from "@/lib/oauth/scopes";

describe("buildAuthorizationServerMetadata (RFC 8414)", () => {
  it("includes required fields with the supplied issuer", () => {
    const md = buildAuthorizationServerMetadata("https://gw.example.com");
    expect(md.issuer).toBe("https://gw.example.com");
    expect(md.authorization_endpoint).toBe("https://gw.example.com/oauth/authorize");
    expect(md.token_endpoint).toBe("https://gw.example.com/oauth/token");
    expect(md.registration_endpoint).toBe("https://gw.example.com/oauth/register");
    expect(md.revocation_endpoint).toBe("https://gw.example.com/oauth/revoke");
    expect(md.code_challenge_methods_supported).toEqual(["S256"]);
    expect(md.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(md.response_types_supported).toContain("code");
    expect(md.token_endpoint_auth_methods_supported).toContain("none");
    expect(md.scopes_supported).toEqual([...SUPPORTED_SCOPES]);
  });

  it("strips trailing slash from issuer", () => {
    const md = buildAuthorizationServerMetadata("https://gw.example.com/");
    expect(md.issuer).toBe("https://gw.example.com");
    expect(md.authorization_endpoint).toBe("https://gw.example.com/oauth/authorize");
  });
});

describe("buildProtectedResourceMetadata (RFC 9728, multi-resource)", () => {
  it("points the resource at /mcp/<org> for an org-level resource", () => {
    const md = buildProtectedResourceMetadata("https://gw.example.com", "contoso", null);
    expect(md.resource).toBe("https://gw.example.com/mcp/contoso");
    expect(md.authorization_servers).toEqual(["https://gw.example.com"]);
    expect(md.bearer_methods_supported).toContain("header");
    expect(md.scopes_supported).toEqual([...SUPPORTED_SCOPES]);
  });

  it("points the resource at /mcp/<org>/<app> for an (org, app)-level resource", () => {
    const md = buildProtectedResourceMetadata("https://gw.example.com", "contoso", "servicefusion");
    expect(md.resource).toBe("https://gw.example.com/mcp/contoso/servicefusion");
    expect(md.authorization_servers).toEqual(["https://gw.example.com"]);
  });

  it("strips a trailing slash from issuer before deriving the resource", () => {
    const md = buildProtectedResourceMetadata("https://gw.example.com/", "contoso", null);
    expect(md.resource).toBe("https://gw.example.com/mcp/contoso");
  });
});
