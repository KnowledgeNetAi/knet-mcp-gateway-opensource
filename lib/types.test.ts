import { describe, it, expect } from "vitest";
import type { AppConfig, Grant } from "@/lib/types";

describe("types", () => {
  it("AppConfig accepts a minimal read-only app", () => {
    const c: AppConfig = {
      app: "demo",
      displayName: "Demo",
      baseUrl: "https://example.test/v1",
      auth: {
        type: "oauth2_client_credentials",
        tokenUrl: "https://example.test/token",
        bodyFormat: "json",
        secrets: { client_id: "demo/id", client_secret: "demo/secret" },
        expiry: { field: "expires_in", coerce: "number", skewSeconds: 60 },
      },
      transport: {
        minIntervalMs: 600,
        timeoutMs: 120000,
        retry: { attempts: 5, on: ["429", "5xx", "truncated"], respectRetryAfter: true },
        errors: { format: "html" },
      },
      tools: [],
    };
    expect(c.tools).toHaveLength(0);
  });

  it("Grant carries unknown roles for admin surfacing", () => {
    const g: Grant = { tools: new Set(["a"]), fields: new Map(), writes: new Map(), unknownRoles: ["gone"] };
    expect(g.unknownRoles).toContain("gone");
  });
});
