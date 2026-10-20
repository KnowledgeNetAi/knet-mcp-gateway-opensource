import { describe, it, expect } from "vitest";
import { buildContext } from "@/lib/mcp/route-deps";
import type { AppEntry } from "@/lib/types";

function entry(org: string, app: string): AppEntry {
  return {
    org, app,
    config: {
      app, displayName: "d", baseUrl: "https://x.test/v1",
      auth: { type: "oauth2_client_credentials", tokenUrl: "https://x.test/token",
              bodyFormat: "json", secrets: { client_id: "a", client_secret: "b" },
              expiry: { field: "expires_in", coerce: "number", skewSeconds: 60 } },
      transport: { minIntervalMs: 300, timeoutMs: 5000,
                   retry: { attempts: 1, on: [], respectRetryAfter: false },
                   errors: { format: "json" } },
      tools: [],
    },
    roles: { roles: {} },
  } as unknown as AppEntry;
}

describe("buildContext — Http memoization (Task 11 fix round 2, finding A)", () => {
  // A fresh `Http` per call means `createHttp`'s closure-local throttle state (`lastAt`)
  // resets every call, so `transport.minIntervalMs` bounds nothing in production — silently
  // undoing the throttle fix from Task 8. `ctx.http` must be the same long-lived instance
  // across calls for the same (org, app), exactly as lib/adapters/run.ts's own comment
  // already assumes it is.
  it("reuses the same Http instance across repeated calls for the same org/app", async () => {
    const e = entry("contoso", "servicefusion");
    const ctx1 = await buildContext(e);
    const ctx2 = await buildContext(e);
    expect(ctx2.http).toBe(ctx1.http);
  });

  it("gives a different org/app its own Http instance (no cross-tenant throttle sharing)", async () => {
    const a = await buildContext(entry("contoso", "servicefusion"));
    const b = await buildContext(entry("other-org", "servicefusion"));
    expect(a.http).not.toBe(b.http);

    const c = await buildContext(entry("contoso", "other-app"));
    expect(c.http).not.toBe(a.http);
  });
});

describe("buildContext — secret reader memoization (S1, Task 12 final review)", () => {
  // `createSecretReader` (lib/secrets/vault.ts) closes over its own TTL `cache` and in-flight
  // `inFlight` dedup map. A fresh reader per `buildContext` call means both start empty every
  // time — the TTL cache never gets a chance to hit, and concurrent callers never get deduped
  // against an in-flight fetch — so every tool call re-reads every secret it needs straight from
  // Vault. `ctx.secret` must be the same long-lived reader instance across calls for the same
  // (org, app), exactly like `ctx.http` already is.
  it("reuses the same secret-reader function across repeated calls for the same org/app", async () => {
    const e = entry("contoso", "servicefusion");
    const ctx1 = await buildContext(e);
    const ctx2 = await buildContext(e);
    expect(ctx2.secret).toBe(ctx1.secret);
  });

  it("gives a different org/app its own secret reader (no cross-tenant cache/dedup sharing)", async () => {
    const a = await buildContext(entry("contoso", "servicefusion"));
    const b = await buildContext(entry("other-org", "servicefusion"));
    expect(a.secret).not.toBe(b.secret);

    const c = await buildContext(entry("contoso", "other-app"));
    expect(c.secret).not.toBe(a.secret);
  });
});
