import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTool } from "@/lib/adapters/run";
import { adapterFor } from "@/lib/adapters/registry";
import { MAX_ADAPTER_UPSTREAM_CALLS } from "@/lib/adapters/types";
import type { AdapterContext, AppAdapter, UpstreamContext } from "@/lib/adapters/types";
import { UpstreamError } from "@/lib/http/errors";
import type { AppEntry, Json, OAuthAuthDef, ToolDef } from "@/lib/types";

// The adapter layer (see lib/adapters/types.ts):
// `ctx.get` for compose/onUpstreamError, the per-call cap, and onUpstreamError itself.

const getTool: ToolDef = {
  name: "thing_get",
  description: "d",
  input: { type: "object", properties: { id: { type: "integer" } } },
  request: { method: "GET", path: "/things/{{id}}" },
};
const composeTool: ToolDef = { name: "thing_summary", description: "d", input: { type: "object" } };

const entry = {
  org: "acme", app: "demo",
  config: {
    app: "demo", displayName: "Demo", baseUrl: "https://api.example.test/base",
    auth: { type: "oauth2_client_credentials", tokenUrl: "https://id.example.test/token",
            bodyFormat: "form", secrets: { client_id: "acme/demo/client_id" },
            expiry: { field: "expires_in", coerce: "number", skewSeconds: 60 } },
    requestHeaders: { tenant_id: "acme/demo/tenant_id" },
    transport: { minIntervalMs: 0, timeoutMs: 5000,
                 retry: { attempts: 1, on: [], respectRetryAfter: false },
                 errors: { format: "json" } },
    tools: [getTool, composeTool],
  },
  roles: { roles: {} },
} as unknown as AppEntry;

type Call = { url: string; headers: Record<string, string>; method?: string };

function recordingCtx(respond: (url: string) => unknown, logs: unknown[][] = []): { ctx: AdapterContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx: AdapterContext = {
    http: {
      request: async (url, init) => {
        calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, method: init?.method });
        const r = respond(url);
        if (r instanceof Error) throw r;
        return { status: 200, data: r as Json, raw: "" };
      },
    },
    secret: async (path) => (path === "acme/demo/tenant_id" ? "tenant-123" : "secret"),
    config: entry.config,
    log: (...a) => { logs.push(a); },
  };
  return { ctx, calls };
}

const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = (async (url: string) => {
    if (url === (entry.config.auth as OAuthAuthDef).tokenUrl) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
});
afterEach(() => { global.fetch = originalFetch; });

describe("compose ctx.get", () => {
  it("reads under baseUrl with the same auth and requestHeaders a declarative request gets", async () => {
    const { ctx, calls } = recordingCtx(() => ({ ok: true }));
    const out = await runTool(entry, composeTool, {}, ctx, {
      compose: async (_a, _t, c) => c.get("/things/7", { expand: "all" }),
    });
    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.example.test/base/things/7?expand=all");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers.Authorization).toBe("Bearer test-token");
    expect(calls[0].headers.tenant_id).toBe("tenant-123");

    // Same headers as the declarative path for the same app.
    const decl = recordingCtx(() => ({}));
    await runTool(entry, getTool, { id: 7 }, decl.ctx);
    expect(decl.calls[0].headers.Authorization).toBe(calls[0].headers.Authorization);
    expect(decl.calls[0].headers.tenant_id).toBe(calls[0].headers.tenant_id);
  });

  it.each([
    ["//evil.example/x"],
    ["/../other"],
    ["/%2e%2e/other"],
    ["https://evil.example/x"],
    ["things/7"],
    [""],
    ["/x/..%2f..%2fetc"],
    ["/x/..%5Cetc"],
    ["/x\\..\\etc"],
    ["/things?admin=1"],
    ["/things#frag"],
    [42 as unknown as string],
  ])("refuses %j before any request is sent", async (path) => {
    const { ctx, calls } = recordingCtx(() => ({}));
    await expect(
      runTool(entry, composeTool, {}, ctx, { compose: async (_a, _t, c) => c.get(path) }),
    ).rejects.toThrow(/adapter get/);
    expect(calls).toHaveLength(0);
  });

  it("keeps an @-path on the app's own host", async () => {
    const { ctx, calls } = recordingCtx(() => ({}));
    await runTool(entry, composeTool, {}, ctx, { compose: async (_a, _t, c) => c.get("/@evil.example") });
    expect(new URL(calls[0].url).host).toBe("api.example.test");
  });

  it("gives hooks no raw http client and no secret reader", async () => {
    const { ctx } = recordingCtx(() => ({}));
    const seen = await runTool(entry, composeTool, {}, ctx, {
      compose: async (_a, _t, c) => Object.keys(c).sort() as unknown as Json,
    });
    expect(seen).toEqual(["config", "get", "log"]);
  });

  it("cannot be repointed by a hook mutating its own config clone", async () => {
    const { ctx, calls } = recordingCtx(() => ({}));
    await runTool(entry, composeTool, {}, ctx, {
      compose: async (_a, _t, c) => {
        (c.config as { baseUrl: string }).baseUrl = "https://evil.example";
        return c.get("/things/1");
      },
    });
    expect(new URL(calls[0].url).host).toBe("api.example.test");
    expect(entry.config.baseUrl).toBe("https://api.example.test/base");
  });

  it("holds the cap under concurrent gets", async () => {
    const { ctx, calls } = recordingCtx(() => ({}));
    await runTool(entry, composeTool, {}, ctx, {
      compose: async (_a, _t, c) => {
        await Promise.allSettled(Array.from({ length: 25 }, (_, i) => c.get(`/things/${i}`)));
        return null;
      },
    });
    expect(calls).toHaveLength(MAX_ADAPTER_UPSTREAM_CALLS);
  });

  it(`caps a single tool call at ${MAX_ADAPTER_UPSTREAM_CALLS} upstream reads`, async () => {
    const { ctx, calls } = recordingCtx(() => ({}));
    await expect(
      runTool(entry, composeTool, {}, ctx, {
        compose: async (_a, _t, c) => {
          for (let i = 0; i < MAX_ADAPTER_UPSTREAM_CALLS + 5; i++) await c.get(`/things/${i}`);
          return null;
        },
      }),
    ).rejects.toThrow(/exceeded 10 upstream calls/);
    expect(calls).toHaveLength(MAX_ADAPTER_UPSTREAM_CALLS);
  });

  it("logs the compose's upstream call count, even when it fails", async () => {
    const logs: unknown[][] = [];
    const { ctx } = recordingCtx((u) => (u.endsWith("/2") ? new UpstreamError(500, u, "boom") : {}), logs);
    await expect(
      runTool(entry, composeTool, {}, ctx, {
        compose: async (_a, _t, c) => { await c.get("/things/1"); return c.get("/things/2"); },
      }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(logs).toContainEqual(["adapter.compose", { tool: "thing_summary", upstreamCalls: 2 }]);
  });
});

describe("onUpstreamError", () => {
  const failing = (status: number) => (u: string) =>
    u.includes("/things/") ? new UpstreamError(status, u, "upstream said no") : {};

  it("may replace the error with a different UpstreamError, after probing with get", async () => {
    const { ctx, calls } = recordingCtx((u) => (u.endsWith("/projects/9") ? new UpstreamError(404, u, "nf") : failing(500)(u)));
    const err = await runTool(entry, getTool, { id: 9 }, ctx, {
      onUpstreamError: async (e, args, c) => {
        try { await c.get(`/projects/${(args as { id: number }).id}`); } catch (p) {
          if (p instanceof UpstreamError && p.status === 404) return new UpstreamError(404, e.path, "no such project");
        }
        return e;
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(404);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/base/things/9", "/base/projects/9"]);
  });

  it("rethrows the ORIGINAL error when the hook returns something other than an UpstreamError", async () => {
    const { ctx } = recordingCtx(failing(500));
    const err = await runTool(entry, getTool, { id: 1 }, ctx, {
      onUpstreamError: (async () => ({ data: "invented" })) as never,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(500);
  });

  it("logs the real upstream status even if the hook mutates the error in place", async () => {
    const logs: unknown[][] = [];
    const { ctx } = recordingCtx(failing(500), logs);
    const err = await runTool(entry, getTool, { id: 1 }, ctx, {
      onUpstreamError: async (e) => { e.status = 404; return e; },
    }).catch((e) => e);
    expect(err.status).toBe(404);
    expect(logs).toContainEqual(["adapter.upstream_error_rewritten", { tool: "thing_get", from: 500, to: 404 }]);
  });

  it.each([[200], [302], [0], [600], [404.5]])("refuses a replacement status of %d and keeps the original", async (status) => {
    const { ctx } = recordingCtx(failing(500));
    const err = await runTool(entry, getTool, { id: 1 }, ctx, {
      onUpstreamError: async (e) => new UpstreamError(status, e.path, "x"),
    }).catch((e) => e);
    expect(err.status).toBe(500);
  });

  it("restores the original status when a mutated error is refused", async () => {
    const { ctx } = recordingCtx(failing(500));
    const err = await runTool(entry, getTool, { id: 1 }, ctx, {
      onUpstreamError: async (e) => { e.status = 200; return e; },
    }).catch((e) => e);
    expect(err.status).toBe(500);
  });

  it("runs on a list tool's failing page", async () => {
    const listTool: ToolDef = {
      name: "things_list", description: "d", input: { type: "object" },
      request: { method: "GET", path: "/things/list" },
      list: { itemsAt: "items", pagination: { style: "page", perPage: 10, maxPages: 2 } },
    };
    const { ctx } = recordingCtx(failing(503));
    const err = await runTool(entry, listTool, {}, ctx, {
      onUpstreamError: async (e) => new UpstreamError(404, e.path, "x"),
    }).catch((e) => e);
    expect(err.status).toBe(404);
  });

  it("rethrows the ORIGINAL error when the hook itself throws", async () => {
    const { ctx } = recordingCtx(failing(500));
    const err = await runTool(entry, getTool, { id: 1 }, ctx, {
      onUpstreamError: async () => { throw new Error("hook bug"); },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(500);
  });

  it("is not consulted for a non-upstream failure", async () => {
    let called = false;
    const { ctx } = recordingCtx(() => new Error("socket hang up"));
    await expect(
      runTool(entry, getTool, { id: 1 }, ctx, { onUpstreamError: async (e) => { called = true; return e; } }),
    ).rejects.toThrow(/socket hang up/);
    expect(called).toBe(false);
  });

  it("does not log a rewrite when the hook returns the error unchanged", async () => {
    const logs: unknown[][] = [];
    const { ctx } = recordingCtx(failing(500), logs);
    await runTool(entry, getTool, { id: 1 }, ctx, { onUpstreamError: async (e) => e }).catch(() => {});
    expect(logs.find((l) => l[0] === "adapter.upstream_error_rewritten")).toBeUndefined();
  });

  it("leaves a successful call untouched", async () => {
    const { ctx } = recordingCtx(() => ({ id: 1 }));
    const out = await runTool(entry, getTool, { id: 1 }, ctx, { onUpstreamError: async () => { throw new Error("unreached"); } });
    expect(out).toEqual({ id: 1 });
  });
});

describe("adapterFor", () => {
  const reg: Record<string, AppAdapter> = { "acme/demo": { tools: { thing_get: { mapItem: (x) => x } } } };

  it("returns the registered hooks for a tool, and none otherwise", () => {
    expect(typeof adapterFor("acme", "demo", "thing_get", reg).mapItem).toBe("function");
    expect(adapterFor("acme", "demo", "other", reg)).toEqual({});
    expect(adapterFor("acme", "nope", "thing_get", reg)).toEqual({});
  });

  it("never resolves through the prototype chain", () => {
    expect(adapterFor("acme", "demo", "constructor", reg)).toEqual({});
    expect(adapterFor("constructor", "x", "y", reg)).toEqual({});
  });
});
