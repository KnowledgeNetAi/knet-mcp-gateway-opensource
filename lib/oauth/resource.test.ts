import { describe, it, expect } from "vitest";
import { resourceUrl, resourceMetadataUrl, parseResource } from "@/lib/oauth/resource";

const ISSUER = "https://gw.example.com";

describe("resource URLs", () => {
  it("builds the org and org/app resource identifiers", () => {
    expect(resourceUrl(ISSUER, "contoso", null)).toBe("https://gw.example.com/mcp/contoso");
    expect(resourceUrl(ISSUER, "contoso", "servicefusion"))
      .toBe("https://gw.example.com/mcp/contoso/servicefusion");
  });

  // RFC 9728 §3.1: the well-known segment is INSERTED after the host, not
  // appended to the path.
  it("inserts the well-known segment after the host, per RFC 9728 section 3.1", () => {
    expect(resourceMetadataUrl(ISSUER, "contoso", null))
      .toBe("https://gw.example.com/.well-known/oauth-protected-resource/mcp/contoso");
    expect(resourceMetadataUrl(ISSUER, "contoso", "servicefusion"))
      .toBe("https://gw.example.com/.well-known/oauth-protected-resource/mcp/contoso/servicefusion");
  });

  it("round-trips a resource it built", () => {
    expect(parseResource(resourceUrl(ISSUER, "contoso", null), ISSUER))
      .toEqual({ orgSlug: "contoso", appSlug: null });
    expect(parseResource(resourceUrl(ISSUER, "contoso", "servicefusion"), ISSUER))
      .toEqual({ orgSlug: "contoso", appSlug: "servicefusion" });
  });

  it("rejects a resource on another origin", () => {
    expect(parseResource("https://evil.example.com/mcp/contoso", ISSUER)).toBeNull();
  });

  it("rejects a slug outside the org charset", () => {
    expect(parseResource("https://gw.example.com/mcp/Acme_Co", ISSUER)).toBeNull();
    expect(parseResource("https://gw.example.com/mcp/../etc", ISSUER)).toBeNull();
  });

  it("rejects paths that are not /mcp/<org>[/<app>]", () => {
    for (const bad of ["https://gw.example.com/", "https://gw.example.com/mcp",
                       "https://gw.example.com/mcp/a/b/c", "https://gw.example.com/other/a"]) {
      expect(parseResource(bad, ISSUER)).toBeNull();
    }
  });

  it("rejects a resource carrying a fragment or query", () => {
    expect(parseResource("https://gw.example.com/mcp/contoso#x", ISSUER)).toBeNull();
    expect(parseResource("https://gw.example.com/mcp/contoso?x=1", ISSUER)).toBeNull();
  });

  it("is not fooled by a trailing slash", () => {
    expect(parseResource("https://gw.example.com/mcp/contoso/", ISSUER))
      .toEqual({ orgSlug: "contoso", appSlug: null });
  });
});
