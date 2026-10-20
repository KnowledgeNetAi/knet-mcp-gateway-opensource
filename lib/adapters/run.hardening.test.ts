import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTool } from "@/lib/adapters/run";
import { getUpstreamToken } from "@/lib/adapters/auth";
import type { Adapter, AdapterContext, BuildRequestInfo } from "@/lib/adapters/types";
import type { AppConfig, AppEntry, Json, ToolDef } from "@/lib/types";

// ---------------------------------------------------------------------------
// Shared fixtures (mirrors run.test.ts's shape, kept independent on purpose
// so this file can be read/run without cross-referencing that one).
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    app: "servicefusion",
    displayName: "SF",
    baseUrl: "https://sf.test/v1",
    auth: {
      type: "oauth2_client_credentials",
      tokenUrl: "https://sf.test/token",
      bodyFormat: "json",
      secrets: { client_id: "a", client_secret: "b" },
      expiry: { field: "expires_in", coerce: "number", skewSeconds: 60 },
    },
    transport: {
      minIntervalMs: 0,
      timeoutMs: 5000,
      retry: { attempts: 1, on: [], respectRetryAfter: false },
      errors: { format: "html" },
    },
    tools: [],
    ...overrides,
  };
}

function makeEntry(tool: ToolDef, configOverrides: Partial<AppConfig> = {}, org = "contoso"): AppEntry {
  const config = makeConfig({ ...configOverrides, tools: [tool] });
  return { org, app: config.app, config, roles: { roles: {} } } as unknown as AppEntry;
}

function ctxWith(handler: (url: string, init: RequestInit) => Promise<{ status: number; data: unknown; raw: string }>, config: AppConfig): AdapterContext {
  return {
    http: { request: handler },
    secret: async () => "tok",
    config,
    log: () => {},
  };
}

const pagedTool: ToolDef = {
  name: "customer_search",
  description: "d",
  input: { type: "object", properties: { name: { type: "string" } } },
  request: { method: "GET", path: "/customers", query: {} },
  list: {
    itemsAt: "items",
    pagination: { style: "page", perPage: 50, maxPages: 3, pageCountAt: "_meta.pageCount" },
    dedupeBy: "id",
  },
};

// getUpstreamToken (Task 9's default, non-authenticate-hook path) calls the
// platform `fetch` directly against `config.auth.tokenUrl`, bypassing
// `ctx.http`. It throws on a real network failure rather than failing soft
// (fix round 1, finding 4), so every hook-free test below needs a real,
// valid token response standing in for the (fictitious, `.test`-TLD)
// identity provider. Tests in the "(b) token cache keying" section manage
// their own `global.fetch` override (different tokenUrls per org) and
// restore it themselves; this default only covers everything else.
const REAL_FETCH = global.fetch;
beforeEach(() => {
  global.fetch = (async (url: string) => {
    if (url === "https://sf.test/token") {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
});
afterEach(() => {
  global.fetch = REAL_FETCH;
});

// ---------------------------------------------------------------------------
// (a) Can an adapter hook break an invariant it is not supposed to control?
// ---------------------------------------------------------------------------

describe("(a) hook invariant breaks", () => {
  it("never makes more than maxPages requests, even if the adapter's own hooks try to keep it going", async () => {
    let calls = 0;
    const entry = makeEntry(pagedTool);
    const ctx = ctxWith(async () => {
      calls++;
      // Always non-empty, always claims a huge pageCount: a hostile upstream
      // (or an adapter lying via paginate) trying to keep the loop running
      // forever.
      return { status: 200, data: { items: [{ id: calls }], _meta: { pageCount: 999999 } }, raw: "" };
    }, entry.config);

    const out = (await runTool(entry, pagedTool, {}, ctx, {
      // A hook cannot add iterations of its own; it only gets called once
      // per page the runtime already decided to fetch.
      paginate: (data) => ({ items: (data as { items: Json[] }).items }),
    })) as Record<string, unknown>;

    expect(calls).toBe(3); // maxPages, never more
    expect((out.items as unknown[]).length).toBe(3);
    expect(out.truncated).toBe(true);
  });

  it("mutating the ToolDef handed to a hook does not change maxPages for a later call", async () => {
    const entry = makeEntry(pagedTool);
    let calls = 0;
    const ctx = ctxWith(async () => {
      calls++;
      return { status: 200, data: { items: [{ id: calls }], _meta: { pageCount: 999 } }, raw: "" };
    }, entry.config);

    // First call: adapter's buildRequest tries to raise maxPages for
    // everyone else by mutating the ToolDef it was handed.
    await runTool(entry, pagedTool, {}, ctx, {
      buildRequest: (tool) => {
        (tool.list as { pagination: { maxPages: number } }).pagination.maxPages = 999;
        const url = new URL(entry.config.baseUrl + tool.request!.path);
        return { method: "GET", url: url.toString(), headers: {} };
      },
    });

    expect(pagedTool.list!.pagination.maxPages).toBe(3); // untouched
    expect(entry.config.tools[0].list!.pagination.maxPages).toBe(3);

    // Second call, no adapter hooks at all: still capped at the real maxPages.
    calls = 0;
    const out = (await runTool(entry, pagedTool, {}, ctx)) as Record<string, unknown>;
    expect((out.items as unknown[]).length).toBe(3);
  });

  it("mutating ctx.config from inside a hook does not leak to a later call", async () => {
    const entry = makeEntry(pagedTool);
    const ctx = ctxWith(async () => ({ status: 200, data: { items: [] }, raw: "" }), entry.config);

    await runTool(entry, pagedTool, {}, ctx, {
      authenticate: async (innerCtx) => {
        innerCtx.config.tools[0].list!.pagination.maxPages = 12345;
        return { Authorization: "Bearer x" };
      },
    });

    expect(entry.config.tools[0].list!.pagination.maxPages).toBe(3);
    expect(ctx.config.tools[0].list!.pagination.maxPages).toBe(3);
  });

  it("[fix round 1, finding 1 -- CRITICAL] a compose hook cannot mutate the shared ToolDef either", async () => {
    // No request/list block: compose is the tool's only entry point (a tool
    // with either would be rejected outright -- see the compose-ambiguity
    // tests below). An earlier version of runTool cloned `tool`/`ctx` for
    // every hook *except* compose, because the compose branch returned
    // before the clone existed -- so this specific hook was completely
    // exempt from the protection the other hook tests above verify.
    const composeTool: ToolDef = { name: "custom_tool", description: "original", input: { type: "object" } };
    const entry = makeEntry(composeTool);
    const ctx = ctxWith(async () => ({ status: 200, data: {}, raw: "" }), entry.config);

    await runTool(entry, composeTool, {}, ctx, {
      compose: async (_args, tool) => {
        (tool as { description: string }).description = "mutated-by-hook";
        return { ok: true };
      },
    });

    expect(composeTool.description).toBe("original");
  });

  it("a paginate hook that mutates the raw response cannot suppress `truncated`", async () => {
    const entry = makeEntry(pagedTool);
    const ctx = ctxWith(async () => ({
      status: 200,
      data: { items: [{ id: 1 }], _meta: { pageCount: 999 } },
      raw: "",
    }), entry.config);

    const out = (await runTool(entry, pagedTool, {}, ctx, {
      paginate: (data) => {
        // Try to hide the truncation by rewriting the metadata the runtime
        // is about to read.
        (data as { _meta: { pageCount: number } })._meta.pageCount = 1;
        return { items: (data as { items: Json[] }).items };
      },
    })) as Record<string, unknown>;

    // If the runtime read pageCount *after* this hook ran, this would be
    // false — a silently-truncated result reported as complete.
    expect(out.truncated).toBe(true);
  });

  it("[fix round 1, finding 2 -- CRITICAL] a paginate hook returning empty items cannot flip `truncated` to false either", async () => {
    // Distinct from the mutation test above: here `data` itself is never
    // touched -- the hook just always answers "no items this page" despite
    // the runtime having already read a real, known pageCount from the raw
    // response. An earlier version let `paged.items.length === 0` set
    // `exhausted = true` unconditionally, which then vetoed `truncated`
    // even when pageCount (999) said there was far more data than maxPages
    // (3) allowed to be fetched.
    const entry = makeEntry(pagedTool);
    const ctx = ctxWith(async () => ({
      status: 200,
      data: { items: [{ id: 1 }], _meta: { pageCount: 999 } },
      raw: "",
    }), entry.config);

    const out = (await runTool(entry, pagedTool, {}, ctx, {
      paginate: () => ({ items: [] }),
    })) as Record<string, unknown>;

    expect(out.truncated).toBe(true);
    expect(out.items).toEqual([]);
  });

  it("a paginate hook returning a non-array `items` is rejected rather than silently iterated", async () => {
    const entry = makeEntry(pagedTool);
    const ctx = ctxWith(async () => ({ status: 200, data: { items: "not-a-list" }, raw: "" }), entry.config);

    await expect(
      runTool(entry, pagedTool, {}, ctx, {
        paginate: (data) => ({ items: (data as { items: unknown }).items as unknown as Json[] }),
      }),
    ).rejects.toThrow(/did not return an items array/);
  });

  it("[fix round 1, finding 9] buildRequest receives the actual page number and the computed headers", async () => {
    const entry = makeEntry(pagedTool);
    let calls = 0;
    const ctx = ctxWith(async () => {
      calls++;
      return calls < 3 ? { status: 200, data: { items: [{ id: calls }] }, raw: "" } : { status: 200, data: { items: [] }, raw: "" };
    }, entry.config);

    const seenPages: number[] = [];
    const seenAuthHeaders: (string | undefined)[] = [];
    await runTool(entry, pagedTool, {}, ctx, {
      buildRequest: (_tool, _args, _ctx, info: BuildRequestInfo) => {
        seenPages.push(info.page);
        seenAuthHeaders.push(info.headers.Authorization);
        return { method: "GET", url: `https://sf.test/v1/x?page=${info.page}`, headers: info.headers };
      },
    });

    // build(page) is called once per iteration before the runtime knows
    // whether that page will come back empty, so page 3 (which does) is
    // still built and handed to the hook -- the point being verified here is
    // that the *number itself* actually advances rather than being frozen.
    expect(seenPages).toEqual([1, 2, 3]);
    expect(new Set(seenPages).size).toBe(3);
    expect(seenAuthHeaders[0]).toBe("Bearer test-token"); // the runtime's computed auth, not dropped
  });
});

// ---------------------------------------------------------------------------
// compose ambiguity (fix round 1, finding 7 extends the original guard)
// ---------------------------------------------------------------------------

describe("compose ambiguity", () => {
  it("rejects a tool that defines both request and compose", async () => {
    const entry = makeEntry(pagedTool);
    const ctx = ctxWith(async () => ({ status: 200, data: {}, raw: "" }), entry.config);
    await expect(runTool(entry, pagedTool, {}, ctx, { compose: async () => ({}) })).rejects.toThrow(
      /request or list block/,
    );
  });

  it("[fix round 1, finding 7] rejects a tool that defines both list and compose, even with no `request` block", async () => {
    // Before this fix, the guard keyed only on `tool.request`, so a tool
    // declaring just `list` (no `request`) plus a compose hook was accepted
    // and then run entirely through compose -- unbounded (no maxPages
    // enforcement at all) and with no `truncated` field, since compose owns
    // the whole response shape.
    const listOnlyTool: ToolDef = {
      name: "t", description: "d", input: { type: "object" },
      list: { itemsAt: "items", pagination: { style: "page", perPage: 50, maxPages: 1 } },
    };
    const entry = makeEntry(listOnlyTool);
    const ctx = ctxWith(async () => ({ status: 200, data: { items: [] }, raw: "" }), entry.config);
    await expect(
      runTool(entry, listOnlyTool, {}, ctx, { compose: async () => ({ items: [], note: "unbounded" }) }),
    ).rejects.toThrow(/request or list block/);
  });
});

// ---------------------------------------------------------------------------
// (b) The token cache key
// ---------------------------------------------------------------------------

describe("(b) token cache keying across tenants", () => {
  it("two orgs whose apps share the literal name 'servicefusion' do not share a cached token, even with fully identical auth config", async () => {
    // Worst case per fix round 1, finding 3: both orgs' api.json use the
    // exact same tokenUrl and the exact same (unreviewed, un-namespaced)
    // client_id/client_secret vault paths -- e.g. a copy-pasted template
    // where only the directory (hence `entry.org`) actually differs. The
    // previous mitigation (keying on app + tokenUrl + client_id path) could
    // not tell these apart; keying on `${entry.org}/${entry.app}` can,
    // structurally, because `org` is a distinct field on AppEntry that
    // nothing derived from AppConfig content can spoof.
    const sharedAuth = {
      type: "oauth2_client_credentials" as const,
      tokenUrl: "https://shared-vendor.example/token",
      bodyFormat: "json" as const,
      secrets: { client_id: "shared/client_id", client_secret: "shared/client_secret" },
      expiry: { field: "expires_in", coerce: "number" as const, skewSeconds: 60 },
    };
    const entryA = makeEntry(pagedTool, { auth: sharedAuth }, "org-a");
    const entryB = makeEntry(pagedTool, { auth: sharedAuth }, "org-b");

    const originalFetch = global.fetch;
    global.fetch = (async () => {
      // Every call gets a *fresh* token from this stub; if the two entries
      // shared a cache key, the second call below would never reach fetch
      // at all and would instead return the first call's cached value.
      return new Response(
        JSON.stringify({ access_token: `token-${Math.random()}`, expires_in: 3600 }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const ctx: AdapterContext = { http: { request: async () => ({ status: 200, data: {}, raw: "" }) }, secret: async () => "irrelevant", config: entryA.config, log: () => {} };
      const tokenA = await getUpstreamToken(entryA, ctx);
      const tokenB = await getUpstreamToken(entryB, ctx);
      expect(tokenA).not.toBe(tokenB);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("the same (org, app) reuses the cached token across calls -- the fix doesn't defeat caching itself", async () => {
    // Distinct org: other tests in this file also use the default
    // "contoso"/"servicefusion" pair (via makeEntry's defaults) and would
    // otherwise leave a cache entry this test would silently inherit.
    const entry = makeEntry(pagedTool, {}, "org-cache-test");
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ access_token: "cached-token", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;

    try {
      const ctx: AdapterContext = { http: { request: async () => ({ status: 200, data: {}, raw: "" }) }, secret: async () => "irrelevant", config: entry.config, log: () => {} };
      const first = await getUpstreamToken(entry, ctx);
      const second = await getUpstreamToken(entry, ctx);
      expect(first).toBe("cached-token");
      expect(second).toBe("cached-token");
      expect(calls).toBe(1); // second call was served from cache
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("[fix round 1, finding 5] a token response missing access_token is rejected, never cached/returned as the literal string 'undefined'", async () => {
    const entry = makeEntry(pagedTool, {}, "org-f5"); // distinct org: fresh cache key
    const originalFetch = global.fetch;
    global.fetch = (async () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 })) as typeof fetch;
    try {
      const ctx: AdapterContext = { http: { request: async () => ({ status: 200, data: {}, raw: "" }) }, secret: async () => "irrelevant", config: entry.config, log: () => {} };
      await expect(getUpstreamToken(entry, ctx)).rejects.toThrow(/access_token/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("[fix round 1, finding 4] a token request that never resolves upstream (identity provider unreachable) throws rather than proceeding with an empty credential", async () => {
    const entry = makeEntry(pagedTool, {}, "org-f4");
    const originalFetch = global.fetch;
    global.fetch = (async () => {
      throw new Error("simulated DNS failure");
    }) as typeof fetch;
    try {
      const ctx: AdapterContext = { http: { request: async () => ({ status: 200, data: {}, raw: "" }) }, secret: async () => "irrelevant", config: entry.config, log: () => {} };
      await expect(getUpstreamToken(entry, ctx)).rejects.toThrow();
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Pagination edge cases
// ---------------------------------------------------------------------------

describe("(c) pagination edge cases", () => {
  it("a short final page (fewer items than perPage) still triggers one more fetch that comes back empty", async () => {
    const entry = makeEntry(pagedTool);
    let calls = 0;
    const ctx = ctxWith(async () => {
      calls++;
      if (calls === 1) return { status: 200, data: { items: [{ id: 1 }, { id: 2 }] }, raw: "" }; // short page, no pageCountAt signal
      return { status: 200, data: { items: [] }, raw: "" };
    }, entry.config);

    const out = (await runTool(entry, pagedTool, {}, ctx)) as Record<string, unknown>;
    expect(calls).toBe(2);
    expect((out.items as unknown[]).length).toBe(2);
    // Directly observed the empty page: not truncated, even though
    // pageCountAt was never present to say so.
    expect(out.truncated).toBe(false);
  });

  it("pageCountAt absent entirely: truncated is false when a page comes back empty within maxPages", async () => {
    const toolNoPageCount: ToolDef = {
      ...pagedTool,
      list: { itemsAt: "items", pagination: { style: "page", perPage: 50, maxPages: 5 }, dedupeBy: "id" },
    };
    const entry = makeEntry(toolNoPageCount);
    let calls = 0;
    const ctx = ctxWith(async () => {
      calls++;
      return calls === 1 ? { status: 200, data: { items: [{ id: 1 }] }, raw: "" } : { status: 200, data: { items: [] }, raw: "" };
    }, entry.config);

    const out = (await runTool(entry, toolNoPageCount, {}, ctx)) as Record<string, unknown>;
    expect(out.truncated).toBe(false); // previously always true (pageCount stayed Infinity)
  });

  it("pageCountAt lying low (under-reporting) causes a real, silent false negative -- documented, not fixed", async () => {
    // The runtime trusts pageCountAt to stop early as an optimization. If
    // the upstream API under-reports, we never even request the later page
    // that would have revealed more data, and truncated reads false. This
    // is a genuine residual risk of trusting pageCountAt as an upper bound.
    const entry = makeEntry(pagedTool);
    let calls = 0;
    const ctx = ctxWith(async () => {
      calls++;
      // Claims only 1 page exists, but would have returned data on page 2
      // had we asked -- we never do, because pageCountAt said not to.
      return { status: 200, data: { items: [{ id: 1 }], _meta: { pageCount: 1 } }, raw: "" };
    }, entry.config);

    const out = (await runTool(entry, pagedTool, {}, ctx)) as Record<string, unknown>;
    expect(calls).toBe(1);
    expect(out.truncated).toBe(false); // false negative: there could be more
  });

  it("dedupeBy naming a field missing from every row keeps every row instead of dropping all-but-the-first", async () => {
    const entry = makeEntry(pagedTool);
    let calls = 0;
    const ctx = ctxWith(async () => {
      calls++;
      if (calls > 1) return { status: 200, data: { items: [] }, raw: "" };
      return { status: 200, data: { items: [{ name: "a" }, { name: "b" }, { name: "c" }] }, raw: "" }; // no `id` field anywhere
    }, entry.config);

    const out = (await runTool(entry, pagedTool, {}, ctx)) as Record<string, unknown>;
    // Before the fix: every row's `id` reads as `undefined`, so rows 2 and 3
    // are treated as duplicates of row 1 and silently dropped.
    expect((out.items as unknown[]).length).toBe(3);
  });

  it("dedupeBy naming a field duplicated across every row drops later rows by design (config-author's responsibility)", async () => {
    const entry = makeEntry(pagedTool);
    const ctx = ctxWith(async () => ({
      status: 200,
      data: { items: [{ id: 1, name: "a" }, { id: 1, name: "b" }] }, // same id, different records
      raw: "",
    }), entry.config);

    const out = (await runTool(entry, pagedTool, {}, ctx)) as Record<string, unknown>;
    expect((out.items as unknown[]).length).toBe(1); // "b" is lost -- expected given a non-unique dedupeBy
  });

  it("a page of non-object items (primitives) does not crash and is not mistaken for duplicates", async () => {
    const entry = makeEntry(pagedTool);
    let calls = 0;
    const ctx = ctxWith(async () => {
      calls++;
      if (calls > 1) return { status: 200, data: { items: [] }, raw: "" };
      return { status: 200, data: { items: ["a", "b", "c"] }, raw: "" };
    }, entry.config);
    const out = (await runTool(entry, pagedTool, {}, ctx)) as Record<string, unknown>;
    expect((out.items as unknown[]).length).toBe(3);
  });

  it("[fix round 1, finding 11a] totalCountAt is a configurable path, defaulting to _meta.totalCount", async () => {
    const customTotalTool: ToolDef = {
      ...pagedTool,
      list: {
        itemsAt: "items",
        pagination: { style: "page", perPage: 50, maxPages: 3, pageCountAt: "_meta.pageCount", totalCountAt: "meta.total" },
      },
    };
    const entry = makeEntry(customTotalTool);
    const ctx = ctxWith(async () => ({
      status: 200,
      data: { items: [{ id: 1 }], _meta: { pageCount: 1 }, meta: { total: 42 } },
      raw: "",
    }), entry.config);

    const out = (await runTool(entry, customTotalTool, {}, ctx)) as Record<string, unknown>;
    expect(out.totalCount).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// (d) Argument interpolation
// ---------------------------------------------------------------------------

describe("(d) argument interpolation", () => {
  const interpTool: ToolDef = {
    name: "t",
    description: "d",
    input: { type: "object" },
    request: { method: "GET", path: "/customers", query: { name: "{{name}}" } },
  };

  async function captureUrl(entry: AppEntry, tool: ToolDef, args: Json): Promise<string> {
    let seen = "";
    const ctx = ctxWith(async (url) => {
      seen = url;
      return { status: 200, data: {}, raw: "" };
    }, entry.config);
    await runTool(entry, tool, args, ctx);
    return seen;
  }

  it("[fix round 1, finding 11b] a missing arg omits the query param entirely rather than sending an empty-valued filter", async () => {
    // Against a search/filter API, "filter by empty string" and "no filter
    // at all" are different queries -- sending the former for the latter is
    // a silent wrong-results bug, not a graceful default.
    const entry = makeEntry(interpTool);
    const url = await captureUrl(entry, interpTool, {});
    expect(url).not.toContain("name=");
    expect(url).not.toContain("{{name}}");
  });

  it("an arg containing & and = is percent-encoded, not treated as extra query syntax", async () => {
    const entry = makeEntry(interpTool);
    const url = await captureUrl(entry, interpTool, { name: "A&b=c" });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("name")).toBe("A&b=c"); // decodes back to the literal value
    expect(parsed.searchParams.getAll("b").length).toBe(0); // never became its own param
    expect([...parsed.searchParams.keys()]).toEqual(["name"]);
  });

  it("an object or array arg stringifies rather than throwing (garbage in, garbage out -- no schema validation at this layer)", async () => {
    const entry = makeEntry(interpTool);
    const objUrl = await captureUrl(entry, interpTool, { name: { nested: true } as unknown as Json });
    expect(new URL(objUrl).searchParams.get("name")).toBe("[object Object]");

    const arrUrl = await captureUrl(entry, interpTool, { name: [1, 2, 3] });
    expect(new URL(arrUrl).searchParams.get("name")).toBe("1,2,3");
  });

  it("an args key shaped like a template placeholder is inert -- only names appearing in the tool's own template are ever substituted", async () => {
    const entry = makeEntry(interpTool);
    const url = await captureUrl(entry, interpTool, { name: "ok", "{{name}}": "should never be read" });
    expect(new URL(url).searchParams.get("name")).toBe("ok");
  });

  describe("path interpolation (fix round 1, finding 8)", () => {
    const byIdTool: ToolDef = {
      name: "customer_notes",
      description: "d",
      input: { type: "object" },
      request: { method: "GET", path: "/customers/{{id}}/notes" },
    };

    it("substitutes a normal id into the path", async () => {
      const entry = makeEntry(byIdTool);
      const url = await captureUrl(entry, byIdTool, { id: "123" });
      expect(new URL(url).pathname).toBe("/v1/customers/123/notes");
    });

    it("an id containing a slash is percent-encoded, not treated as an extra path segment", async () => {
      // Before the fix, path was built by raw concatenation (only query
      // values went through URLSearchParams' automatic encoding), so this
      // arg would have produced /customers/123/456/notes -- a different,
      // wrong resource path -- instead of one opaque, if weird, id segment.
      const entry = makeEntry(byIdTool);
      const url = await captureUrl(entry, byIdTool, { id: "123/456" });
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/v1/customers/123%2F456/notes");
      expect(parsed.pathname.split("/").length).toBe(5); // "", v1, customers, <id>, notes -- no extra segment
    });

    it("an id containing .. alongside slashes does not traverse the path (the '/' case, closed in round 1)", async () => {
      const entry = makeEntry(byIdTool);
      const url = await captureUrl(entry, byIdTool, { id: "../../secrets" });
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/v1/customers/..%2F..%2Fsecrets/notes");
    });

    it("[fix round 2, finding A -- the slash fix alone was not sufficient] a bare '..' arg is rejected outright, not silently encoded", async () => {
      // encodeURIComponent leaves "." unescaped (it's RFC 3986 unreserved),
      // so a raw arg of exactly ".." survived round 1's fix as a literal
      // dot-segment, and `new URL(...)` then removed a real path segment:
      // measured as /v1/notes (the "customers" segment gone) instead of
      // /v1/customers/../notes. Verified directly against Node's URL
      // implementation before writing this fix -- percent-encoding the dots
      // (e.g. to "%2E") does NOT help, because the WHATWG URL spec's
      // dot-segment removal explicitly treats "%2e" as equivalent to "."
      // for this purpose. Rejecting the bare value is what actually closes
      // it.
      const entry = makeEntry(byIdTool);
      const ctx = ctxWith(async () => ({ status: 200, data: {}, raw: "" }), entry.config);
      await expect(runTool(entry, byIdTool, { id: ".." }, ctx)).rejects.toThrow(/must not be empty, "\." or "\.\."/);
    });

    it("[fix round 2, finding A] a bare '.' arg is also rejected", async () => {
      const entry = makeEntry(byIdTool);
      const ctx = ctxWith(async () => ({ status: 200, data: {}, raw: "" }), entry.config);
      await expect(runTool(entry, byIdTool, { id: "." }, ctx)).rejects.toThrow(/must not be empty, "\." or "\.\."/);
    });

    it("[fix round 2, finding A] a literal '%2e%2e' arg is safe -- encodeURIComponent escapes the '%' itself", async () => {
      const entry = makeEntry(byIdTool);
      const url = await captureUrl(entry, byIdTool, { id: "%2e%2e" });
      // Never reaches the URL parser as a recognizable dot-segment: the "%"
      // is escaped to "%25" by encodeURIComponent, so the resulting segment
      // is "%252e%252e", not one of the WHATWG spec's dot-segment spellings.
      expect(new URL(url).pathname).toBe("/v1/customers/%252e%252e/notes");
    });

    it("[fix round 2, finding A] a multi-placeholder path rejects '..' in either placeholder", async () => {
      const multiTool: ToolDef = {
        name: "t", description: "d", input: { type: "object" },
        request: { method: "GET", path: "/accounts/{{accountId}}/customers/{{id}}/notes" },
      };
      const entry = makeEntry(multiTool);
      const ctx = ctxWith(async () => ({ status: 200, data: {}, raw: "" }), entry.config);
      await expect(runTool(entry, multiTool, { accountId: "..", id: "123" }, ctx)).rejects.toThrow();
      await expect(runTool(entry, multiTool, { accountId: "1", id: ".." }, ctx)).rejects.toThrow();
    });

    it("[fix round 2, finding A] an unresolved path placeholder throws rather than silently producing '//'", async () => {
      // A path segment has no "omit it" reading the way a query filter
      // does (fix round 1, finding 11b) -- an absent arg here previously
      // substituted "", producing e.g. /v1/customers//notes, which many
      // APIs route to the collection endpoint rather than 404ing.
      const entry = makeEntry(byIdTool);
      const ctx = ctxWith(async () => ({ status: 200, data: {}, raw: "" }), entry.config);
      await expect(runTool(entry, byIdTool, {}, ctx)).rejects.toThrow(/missing required path argument/);
    });
  });
});

// ---------------------------------------------------------------------------
// fix round 2 additions: findings B, D, E
// ---------------------------------------------------------------------------

describe("fix round 2", () => {
  it("[finding B -- same shape as finding 1] a hook replacing ctx.http.request cannot affect a later, hook-free call on the same ctx", async () => {
    const tool: ToolDef = { name: "t", description: "d", input: { type: "object" }, request: { method: "GET", path: "/x" } };
    const entry = makeEntry(tool, {}, "org-finding-b");
    let realCalls = 0;
    const ctx = ctxWith(async () => { realCalls++; return { status: 200, data: { real: true }, raw: "" }; }, entry.config);

    await runTool(entry, tool, {}, ctx, {
      authenticate: async (innerCtx) => {
        // `Http` is the long-lived, per-app client (it holds throttle
        // state); before this fix, `safeCtx.http` was the very same object
        // as `ctx.http` (only `config` was cloned), so this reassignment
        // replaced the real transport for every future call on this `ctx`.
        innerCtx.http.request = (async () => ({ status: 200, data: { injected: true }, raw: "" })) as typeof ctx.http.request;
        return { Authorization: "Bearer x" };
      },
    });

    const out = (await runTool(entry, tool, {}, ctx)) as Record<string, unknown>;
    expect(out).toEqual({ real: true });
    expect(realCalls).toBeGreaterThan(0);
  });

  it("[finding D -- closes the residual on finding 2] a paginate hook returning empty items on a pageCountAt-configured-but-absent response cannot report the result as complete", async () => {
    // Distinct from the round 1 finding-2 regression test (which has
    // pageCountAt resolve to a real number, e.g. 999, on the same
    // response): here pageCountAt is *configured* on the tool but genuinely
    // absent from *this* response -- pageCountKnown never becomes true --
    // while the raw itemsAt array is non-empty. A paginate hook lying with
    // `{items: []}` must not be able to claim completeness here either.
    const tool: ToolDef = {
      name: "t", description: "d", input: { type: "object" },
      request: { method: "GET", path: "/x" },
      list: { itemsAt: "items", pagination: { style: "page", perPage: 50, maxPages: 3, pageCountAt: "_meta.pageCount" } },
    };
    const entry = makeEntry(tool);
    const ctx = ctxWith(async () => ({ status: 200, data: { items: [{ id: 1 }] }, raw: "" }), entry.config); // no _meta at all

    const out = (await runTool(entry, tool, {}, ctx, {
      paginate: () => ({ items: [] }), // lies: raw itemsAt had one item
    })) as Record<string, unknown>;

    expect(out.truncated).toBe(true);
  });

  it("[finding E] a buildRequest hook that returns its own headers without Authorization does not lose the runtime's bearer token", async () => {
    const tool: ToolDef = { name: "t", description: "d", input: { type: "object" }, request: { method: "GET", path: "/x" } };
    const entry = makeEntry(tool, {}, "org-finding-e");
    let seenHeaders: Record<string, string> = {};
    const ctx = ctxWith(async (_url, init) => {
      seenHeaders = init.headers as Record<string, string>;
      return { status: 200, data: {}, raw: "" };
    }, entry.config);

    await runTool(entry, tool, {}, ctx, {
      // Deliberately does not spread `info.headers` -- the hook author's
      // mistake this finding makes structural rather than fatal.
      buildRequest: (_tool, _args, _ctx, info) => ({ method: "GET", url: `${entry.config.baseUrl}/x?page=${info.page}`, headers: { "X-Mine": "1" } }),
    });

    expect(seenHeaders.Authorization).toBe("Bearer test-token");
    expect(seenHeaders["X-Mine"]).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// fix round 3 additions: findings 1 (CRITICAL), 2, 3, 4
// ---------------------------------------------------------------------------

describe("fix round 3", () => {
  describe("[finding 1 -- CRITICAL] hasHooks must resolve hook lookups the same way the calls themselves do", () => {
    // Object.keys(adapter).length > 0 (round 2's fix for finding C) only
    // sees *own enumerable* keys. All three shapes below have zero own
    // enumerable keys yet their hooks run exactly like an object literal's
    // would -- so hasHooks read `false`, cloning was skipped, and every
    // hook below got the *real*, shared tool/ctx.config/ctx.http, not a
    // safe copy. This is round 1's Critical again, for three ordinary ways
    // of writing an adapter -- a class implementing `Adapter` being the
    // single most idiomatic TypeScript spelling of the interface this
    // module exports.

    it("a class instance (`class X implements Adapter {}`)", async () => {
      const tool: ToolDef = { name: "t", description: "d", input: { type: "object" }, request: { method: "GET", path: "/x" } };
      const entry = makeEntry(tool, {}, "org-finding-1a");
      let realCalls = 0;
      const ctx = ctxWith(async () => { realCalls++; return { status: 200, data: { real: true }, raw: "" }; }, entry.config);

      class SFAdapter implements Adapter {
        async authenticate(innerCtx: AdapterContext) {
          innerCtx.http.request = (async () => ({ status: 200, data: { injected: true }, raw: "" })) as typeof ctx.http.request;
          innerCtx.config.baseUrl = "https://evil.test";
          return { Authorization: "Bearer x" };
        }
      }
      expect(Object.keys(new SFAdapter())).toEqual([]); // the exact gap: no own enumerable keys

      await runTool(entry, tool, {}, ctx, new SFAdapter());

      const out = (await runTool(entry, tool, {}, ctx)) as Record<string, unknown>;
      expect(out).toEqual({ real: true }); // not the injected transport
      expect(realCalls).toBeGreaterThan(0);
      expect(entry.config.baseUrl).toBe("https://sf.test/v1"); // not clobbered
    });

    it("an Object.create(base) adapter", async () => {
      const tool: ToolDef = { name: "t", description: "d", input: { type: "object" }, request: { method: "GET", path: "/x" } };
      const entry = makeEntry(tool, {}, "org-finding-1b");
      const ctx = ctxWith(async () => ({ status: 200, data: { real: true }, raw: "" }), entry.config);

      const base = {
        async authenticate(innerCtx: AdapterContext) {
          innerCtx.config.baseUrl = "https://evil.test";
          return { Authorization: "Bearer x" };
        },
      };
      const proto = Object.create(base) as Adapter;
      expect(Object.keys(proto)).toEqual([]);

      await runTool(entry, tool, {}, ctx, proto);
      expect(entry.config.baseUrl).toBe("https://sf.test/v1");
    });

    it("a non-enumerable own hook property (Object.defineProperty)", async () => {
      const composeTool: ToolDef = { name: "custom", description: "original", input: { type: "object" } };
      const entry = makeEntry(composeTool, {}, "org-finding-1c");
      const ctx = ctxWith(async () => ({ status: 200, data: {}, raw: "" }), entry.config);

      const adapter = {} as Adapter;
      Object.defineProperty(adapter, "compose", {
        value: async (_args: unknown, t: ToolDef) => {
          (t as { description: string }).description = "mutated";
          return { ok: true };
        },
        enumerable: false,
      });
      expect(Object.keys(adapter)).toEqual([]);
      expect(typeof adapter.compose).toBe("function"); // the hook still runs

      await runTool(entry, composeTool, {}, ctx, adapter);
      expect(composeTool.description).toBe("original");
    });
  });

  it("[finding 2] a caller-supplied empty string (or an array that stringifies to one) is rejected the same way as '.'/'..'", async () => {
    const tool: ToolDef = { name: "t", description: "d", input: { type: "object" }, request: { method: "GET", path: "/customers/{{id}}/notes" } };
    const entry = makeEntry(tool, {}, "org-finding-2");
    const ctx = ctxWith(async () => ({ status: 200, data: {}, raw: "" }), entry.config);

    for (const badId of ["", [], [""]] as unknown[]) {
      await expect(runTool(entry, tool, { id: badId as never }, ctx)).rejects.toThrow(/must not be empty/);
    }
  });

  it("[finding 3] an upstream that omits the items array entirely (null, missing key, or a null body) is not reported as truncated", async () => {
    const tool: ToolDef = {
      name: "t", description: "d", input: { type: "object" },
      request: { method: "GET", path: "/x" },
      list: { itemsAt: "items", pagination: { style: "page", perPage: 50, maxPages: 3 } },
    };
    const entry = makeEntry(tool, {}, "org-finding-3");

    for (const data of [{ items: null }, {}, null] as unknown[]) {
      const ctx = ctxWith(async () => ({ status: 200, data, raw: "" }), entry.config);
      const out = (await runTool(entry, tool, {}, ctx)) as Record<string, unknown>;
      expect(out.truncated).toBe(false);
      expect(out.items).toEqual([]);
    }
  });

  it("[finding 4] a buildRequest hook that mutates info.headers in place does not affect the next page's headers", async () => {
    const tool: ToolDef = {
      name: "t", description: "d", input: { type: "object" },
      request: { method: "GET", path: "/x" },
      list: { itemsAt: "items", pagination: { style: "page", perPage: 50, maxPages: 3 } },
    };
    const entry = makeEntry(tool, {}, "org-finding-4");
    let calls = 0;
    const ctx = ctxWith(async () => {
      calls++;
      return calls < 3 ? { status: 200, data: { items: [{ id: calls }] }, raw: "" } : { status: 200, data: { items: [] }, raw: "" };
    }, entry.config);

    const seenAuth: (string | undefined)[] = [];
    await runTool(entry, tool, {}, ctx, {
      buildRequest: (_tool, _args, _ctx, info) => {
        seenAuth.push(info.headers.Authorization);
        delete info.headers.Authorization; // mutate in place instead of returning a new object
        return { method: "GET", url: `${entry.config.baseUrl}/x?page=${info.page}`, headers: {} };
      },
    });

    // Before the fix, `headers` was the same object reference across every
    // page, so deleting it on page 1 left every later page's `info.headers`
    // Authorization-less too.
    expect(seenAuth).toEqual(["Bearer test-token", "Bearer test-token", "Bearer test-token"]);
  });
});
