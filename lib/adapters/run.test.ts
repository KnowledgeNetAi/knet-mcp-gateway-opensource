import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runTool } from "@/lib/adapters/run";
import type { AdapterContext } from "@/lib/adapters/types";
import type { AppEntry, Json, OAuthAuthDef, ToolDef } from "@/lib/types";

const tool: ToolDef = {
  name: "customer_search",
  description: "d",
  input: { type: "object", properties: { name: { type: "string" } } },
  request: { method: "GET", path: "/customers", query: { "filters[customer_name]": "{{name}}" } },
  list: {
    itemsAt: "items",
    pagination: { style: "page", perPage: 50, maxPages: 2, pageCountAt: "_meta.pageCount" },
    defaults: { sort: "-id" },
    dedupeBy: "id",
  },
};

const entry = {
  org: "contoso", app: "servicefusion",
  config: {
    app: "servicefusion", displayName: "SF", baseUrl: "https://sf.test/v1",
    auth: { type: "oauth2_client_credentials", tokenUrl: "https://sf.test/token",
            bodyFormat: "json", secrets: { client_id: "a", client_secret: "b" },
            expiry: { field: "expires_in", coerce: "number", skewSeconds: 60 } },
    transport: { minIntervalMs: 0, timeoutMs: 5000,
                 retry: { attempts: 1, on: [], respectRetryAfter: false },
                 errors: { format: "html" } },
    tools: [tool],
  },
  roles: { roles: {} },
} as unknown as AppEntry;

function ctxWith(pages: Record<string, unknown>): AdapterContext {
  return {
    http: { request: async (url) => ({ status: 200, data: pages[url] ?? { items: [] }, raw: "" }) },
    secret: async () => "tok",
    config: entry.config,
    log: () => {},
  };
}

// getUpstreamToken (Task 9's default, non-authenticate-hook path) calls the
// platform `fetch` directly against `config.auth.tokenUrl`, deliberately
// bypassing `ctx.http` (see lib/adapters/auth.ts). It now throws on a real
// network failure rather than failing soft, so every test below that goes
// through the default header path needs a real, valid token response
// standing in for the (fictitious, `.test`-TLD) identity provider — stubbing
// `fetch` here, rather than softening the runtime, is the fix for fix round
// 1's finding 4.
const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = (async (url: string) => {
    if (url === (entry.config.auth as OAuthAuthDef).tokenUrl) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("runTool", () => {
  it("injects declared query defaults and interpolates args", async () => {
    const seen: string[] = [];
    const ctx: AdapterContext = {
      ...ctxWith({}),
      http: { request: async (url) => { seen.push(url); return { status: 200, data: { items: [] }, raw: "" }; } },
    };
    await runTool(entry, tool, { name: "Acme" }, ctx);
    expect(seen[0]).toContain("sort=-id");
    expect(seen[0]).toContain("per-page=50");
    expect(seen[0]).toContain(encodeURIComponent("Acme"));
  });

  it("lets a caller-supplied query argument override the declared default", async () => {
    const sortableTool = structuredClone(tool);
    sortableTool.input = {
      type: "object",
      properties: { sort: { type: "string" } },
    };
    sortableTool.request!.query = { sort: "{{sort}}" };

    const seen: string[] = [];
    const ctx: AdapterContext = {
      ...ctxWith({}),
      http: {
        request: async (url) => {
          seen.push(url);
          return { status: 200, data: { items: [] }, raw: "" };
        },
      },
    };

    await runTool(entry, sortableTool, { sort: "dateAdded" }, ctx);
    expect(new URL(seen[0]).searchParams.get("sort")).toBe("dateAdded");
  });

  it("expands an array whole-placeholder into repeated query parameters", async () => {
    const repeated = structuredClone(tool);
    repeated.input = {
      type: "object",
      properties: { departments: { type: "array" } },
    };
    repeated.request!.query = { "filters[departments][]": "{{departments}}" };
    const seen: string[] = [];
    const ctx: AdapterContext = {
      ...ctxWith({}),
      http: { request: async (url) => { seen.push(url); return { status: 200, data: { items: [] }, raw: "" }; } },
    };

    await runTool(entry, repeated, { departments: ["HVAC", "Plumbing"] }, ctx);

    const url = new URL(seen[0]);
    expect(url.searchParams.getAll("filters[departments][]")).toEqual(["HVAC", "Plumbing"]);
  });

  it("stops at maxPages and reports truncation", async () => {
    // Distinct id per page: this tool declares dedupeBy "id", so repeating an
    // id here would test dedupe rather than truncation.
    let n = 0;
    const ctx: AdapterContext = {
      ...ctxWith({}),
      http: { request: async () => ({ status: 200,
        data: { items: [{ id: ++n }], _meta: { pageCount: 99 } }, raw: "" }) },
    };
    const out = await runTool(entry, tool, { name: "x" }, ctx) as Record<string, unknown>;
    expect(out.truncated).toBe(true);
    expect((out.items as unknown[]).length).toBe(2); // maxPages is 2
  });

  it("dedupes repeated ids across page boundaries", async () => {
    const ctx: AdapterContext = {
      ...ctxWith({}),
      http: { request: async () => ({ status: 200,
        data: { items: [{ id: 7 }], _meta: { pageCount: 2 } }, raw: "" }) },
    };
    const out = await runTool(entry, tool, { name: "x" }, ctx) as Record<string, unknown>;
    expect(out.items).toEqual([{ id: 7 }]);
  });

  // A tool with no `request` block: compose is its only entry point.
  const composeTool: ToolDef = { name: "custom_tool", description: "d", input: { type: "object" } };

  it("uses compose instead of the fetch path when the adapter defines it", async () => {
    const compose = vi.fn(async () => ({ custom: true }));
    const out = await runTool(entry, composeTool, { name: "x" }, ctxWith({}), { compose });
    expect(compose).toHaveBeenCalled();
    expect(out).toEqual({ custom: true });
  });

  it("rejects a tool that defines both request and compose", async () => {
    // `tool` (shared fixture above) *does* declare a request block. Pairing
    // that with a compose hook is ambiguous about which one runs, so it
    // must be rejected rather than silently preferred — see lib/adapters/run.ts
    // and lib/config/schema.test.ts, which documents this same expectation.
    const compose = vi.fn(async () => ({ custom: true }));
    await expect(runTool(entry, tool, { name: "x" }, ctxWith({}), { compose })).rejects.toThrow(
      /request or list block/,
    );
    expect(compose).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------
  // Task 1: bodyFormat, secrets spread, offset pagination.
  // --------------------------------------------------------------------

  it("sends the token request as JSON when bodyFormat is \"json\" (default/unchanged)", async () => {
    // Distinct `org` per test in this block: getUpstreamToken caches by
    // `${org}/${app}` (module-level, shared across this whole test file), so
    // reusing the shared `entry` fixture's org here would hit an
    // already-cached token from an earlier test and never call fetch.
    const jsonEntry = structuredClone(entry) as AppEntry;
    jsonEntry.org = "test-json-body";

    let captured: { headers?: HeadersInit; body?: BodyInit | null } | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url === (jsonEntry.config.auth as OAuthAuthDef).tokenUrl) {
        captured = { headers: init?.headers, body: init?.body };
        return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    await runTool(jsonEntry, tool, { name: "x" }, ctxWith({}));

    expect((captured?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(captured?.body as string)).toEqual({
      grant_type: "client_credentials",
      client_id: "tok",
      client_secret: "tok",
    });
  });

  it("sends the token request as x-www-form-urlencoded when bodyFormat is \"form\"", async () => {
    const formEntry = structuredClone(entry) as AppEntry;
    formEntry.org = "test-form-body";
    (formEntry.config.auth as OAuthAuthDef).bodyFormat = "form";

    let captured: { headers?: HeadersInit; body?: BodyInit | null } | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url === (formEntry.config.auth as OAuthAuthDef).tokenUrl) {
        captured = { headers: init?.headers, body: init?.body };
        return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    await runTool(formEntry, tool, { name: "x" }, ctxWith({}));

    expect((captured?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const params = new URLSearchParams(captured?.body as string);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("tok");
    expect(params.get("client_secret")).toBe("tok");
  });

  it("spreads every auth.secrets entry into the token body, keyed by its own name", async () => {
    // FieldEdge's shape: a third secret (target_id) with no fixed field to
    // read it from today. The Contoso shape (exactly client_id/client_secret)
    // must still send exactly those two plus grant_type — see the next test.
    const threeSecretEntry = structuredClone(entry) as AppEntry;
    threeSecretEntry.org = "test-three-secrets";
    (threeSecretEntry.config.auth as OAuthAuthDef).secrets = { client_id: "a", client_secret: "b", target_id: "c" };

    let capturedBody: BodyInit | null | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url === (threeSecretEntry.config.auth as OAuthAuthDef).tokenUrl) {
        capturedBody = init?.body;
        return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    const ctx: AdapterContext = {
      ...ctxWith({}),
      secret: async (path: string) => `secret-for-${path}`,
    };
    await runTool(threeSecretEntry, tool, { name: "x" }, ctx);

    expect(JSON.parse(capturedBody as string)).toEqual({
      grant_type: "client_credentials",
      client_id: "secret-for-a",
      client_secret: "secret-for-b",
      target_id: "secret-for-c",
    });
  });

  it("sends exactly client_id/client_secret/grant_type for a config declaring only those two secrets (Contoso shape, unchanged)", async () => {
    const twoSecretEntry = structuredClone(entry) as AppEntry;
    twoSecretEntry.org = "test-two-secrets";

    let capturedBody: BodyInit | null | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      if (url === (twoSecretEntry.config.auth as OAuthAuthDef).tokenUrl) {
        capturedBody = init?.body;
        return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    await runTool(twoSecretEntry, tool, { name: "x" }, ctxWith({}));

    const body = JSON.parse(capturedBody as string);
    expect(Object.keys(body).sort()).toEqual(["client_id", "client_secret", "grant_type"]);
  });

  const offsetTool: ToolDef = {
    name: "work_order_search",
    description: "d",
    input: { type: "object", properties: {} },
    request: { method: "GET", path: "/work-orders" },
    list: {
      itemsAt: "data",
      pagination: { style: "offset", perPage: 200, maxPages: 2, totalCountAt: "total" },
    },
  };

  const offsetEntry = {
    org: "globex",
    app: "fieldedge",
    config: { ...entry.config, tools: [offsetTool] },
    roles: { roles: {} },
  } as unknown as AppEntry;

  it("requests limit/offset for an offset-style pagination tool", async () => {
    const seen: string[] = [];
    const ctx: AdapterContext = {
      ...ctxWith({}),
      config: offsetEntry.config,
      http: {
        request: async (url) => {
          seen.push(url);
          return { status: 200, data: { data: [{ id: seen.length }] }, raw: "" };
        },
      },
    };
    await runTool(offsetEntry, offsetTool, {}, ctx);

    expect(seen).toHaveLength(2); // maxPages is 2
    const first = new URL(seen[0]);
    expect(first.searchParams.get("limit")).toBe("200");
    expect(first.searchParams.get("offset")).toBe("0");
    const second = new URL(seen[1]);
    expect(second.searchParams.get("limit")).toBe("200");
    expect(second.searchParams.get("offset")).toBe("200");
    // Never the page-style parameter names.
    expect(first.searchParams.has("page")).toBe(false);
    expect(first.searchParams.has("per-page")).toBe(false);
  });

  // Found during live verification against FieldEdge, not by a unit test:
  // warehouse_search returned all 98 of 98 records and still reported
  // truncated:true, because an offset API supplies a total but no page count,
  // so `pageCount` stayed Infinity and `truncated = !exhausted && pageCount >
  // maxPages` was true on every call. A model told to "narrow your search"
  // after receiving a complete answer will do so, and lose data it already had.
  it("does not report truncated when an offset tool returned the whole collection", async () => {
    const ctx: AdapterContext = {
      ...ctxWith({}),
      config: offsetEntry.config,
      // total (98) fits inside one page of 200, so one request returns everything.
      http: {
        request: async () => ({
          status: 200,
          data: { total: 98, limit: 200, offset: 0, data: Array.from({ length: 98 }, (_, i) => ({ id: i })) },
          raw: "",
        }),
      },
    };
    const out = (await runTool(offsetEntry, offsetTool, {}, ctx)) as {
      items: unknown[]; truncated: boolean; totalCount?: number;
    };
    expect(out.items).toHaveLength(98);
    expect(out.totalCount).toBe(98);
    expect(out.truncated).toBe(false);
  });

  it("still reports truncated when an offset tool genuinely hits its page cap", async () => {
    // 10,000 records at 200/page with maxPages 2 is a hard cap at 400 — the
    // caller IS holding a prefix and must be told so. This is the assertion
    // that stops the fix above from being "always report complete".
    const ctx: AdapterContext = {
      ...ctxWith({}),
      config: offsetEntry.config,
      http: {
        request: async () => ({
          status: 200,
          data: { total: 10000, limit: 200, offset: 0, data: Array.from({ length: 200 }, (_, i) => ({ id: i })) },
          raw: "",
        }),
      },
    };
    const out = (await runTool(offsetEntry, offsetTool, {}, ctx)) as {
      items: unknown[]; truncated: boolean; totalCount?: number;
    };
    expect(out.items).toHaveLength(400); // maxPages 2 x perPage 200
    expect(out.totalCount).toBe(10000);
    expect(out.truncated).toBe(true);
  });

  it("still requests per-page/page for a page-style pagination tool (unchanged)", async () => {
    const seen: string[] = [];
    const ctx: AdapterContext = {
      ...ctxWith({}),
      http: {
        request: async (url) => {
          seen.push(url);
          return { status: 200, data: { items: [] }, raw: "" };
        },
      },
    };
    await runTool(entry, tool, { name: "x" }, ctx);

    const first = new URL(seen[0]);
    expect(first.searchParams.get("per-page")).toBe("50");
    expect(first.searchParams.get("page")).toBe("1");
    expect(first.searchParams.has("limit")).toBe(false);
    expect(first.searchParams.has("offset")).toBe(false);
  });

  it("applies mapItem to each record", async () => {
    const ctx: AdapterContext = {
      ...ctxWith({}),
      http: { request: async () => ({ status: 200,
        data: { items: [{ id: 1, keep: "a" }], _meta: { pageCount: 1 } }, raw: "" }) },
    };
    const out = await runTool(entry, tool, { name: "x" }, ctx, {
      mapItem: (item) => ({ ...(item as Record<string, Json>), mapped: true }),
    }) as Record<string, unknown>;
    expect((out.items as Record<string, unknown>[])[0].mapped).toBe(true);
  });
});

describe("runTool cursor pagination", () => {
  // HubSpot's shape: opaque `after` token at paging.next.after, items at results.
  const cursorTool: ToolDef = {
    name: "contact_list",
    description: "d",
    input: { type: "object", properties: {} },
    request: { method: "GET", path: "/crm/v3/objects/contacts" },
    list: {
      itemsAt: "results",
      pagination: { style: "cursor", perPage: 2, maxPages: 3, cursorAt: "paging.next.after" },
      dedupeBy: "id",
    },
  };

  /** Answers each request from `pages`, keyed by the `after` value it carried ("" = first page). */
  function cursorCtx(pages: Record<string, unknown>, seen?: string[]): AdapterContext {
    return {
      ...ctxWith({}),
      http: {
        request: async (url: string) => {
          seen?.push(url);
          const after = new URL(url).searchParams.get("after") ?? "";
          return { status: 200, data: pages[after] ?? { results: [] }, raw: "" };
        },
      },
    };
  }

  it("omits the cursor on page one and sends the previous response's token after that", async () => {
    const seen: string[] = [];
    const ctx = cursorCtx(
      {
        "": { results: [{ id: 1 }], paging: { next: { after: "TOK1" } } },
        TOK1: { results: [{ id: 2 }] },
      },
      seen,
    );
    const out = (await runTool(entry, cursorTool, {}, ctx)) as Record<string, unknown>;

    expect(new URL(seen[0]).searchParams.has("after")).toBe(false);
    expect(new URL(seen[0]).searchParams.get("limit")).toBe("2");
    expect(new URL(seen[1]).searchParams.get("after")).toBe("TOK1");
    expect(out.items).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("reports a complete result when the last page carries no next cursor", async () => {
    // pageCount is never known for a cursor API, so without the cursor being
    // treated as a completeness signal this would report truncated:true on a
    // result that returned everything — the FieldEdge warehouse_search defect.
    const ctx = cursorCtx({ "": { results: [{ id: 1 }] } });
    const out = (await runTool(entry, cursorTool, {}, ctx)) as Record<string, unknown>;
    expect(out.truncated).toBe(false);
    expect(out.items).toEqual([{ id: 1 }]);
  });

  it("stops at maxPages and reports truncation when a cursor is still outstanding", async () => {
    let n = 0;
    const ctx: AdapterContext = {
      ...ctxWith({}),
      http: {
        request: async () => ({
          status: 200,
          data: { results: [{ id: ++n }], paging: { next: { after: `TOK${n}` } } },
          raw: "",
        }),
      },
    };
    const out = (await runTool(entry, cursorTool, {}, ctx)) as Record<string, unknown>;
    expect(out.truncated).toBe(true);
    expect((out.items as unknown[]).length).toBe(3); // maxPages
  });

  it("follows the cursor through a page that happens to be empty", async () => {
    // An empty window in a keyset scan is not the end of the collection — the
    // absent cursor is. Treating the empty page as the end would drop page
    // three AND report the result complete.
    const ctx = cursorCtx({
      "": { results: [{ id: 1 }], paging: { next: { after: "TOK1" } } },
      TOK1: { results: [], paging: { next: { after: "TOK2" } } },
      TOK2: { results: [{ id: 3 }] },
    });
    const out = (await runTool(entry, cursorTool, {}, ctx)) as Record<string, unknown>;
    expect(out.items).toEqual([{ id: 1 }, { id: 3 }]);
    expect(out.truncated).toBe(false);
  });

  it("treats a non-string or empty cursor as no further page", async () => {
    for (const paging of [{ next: { after: "" } }, { next: { after: 42 } }, { next: {} }, {}]) {
      const ctx = cursorCtx({ "": { results: [{ id: 1 }], paging } });
      const out = (await runTool(entry, cursorTool, {}, ctx)) as Record<string, unknown>;
      expect(out.truncated, JSON.stringify(paging)).toBe(false);
    }
  });

  it("reads the cursor from the raw response, not from anything a paginate hook returns", async () => {
    // Same invariant pageCountAt already has: a hook receives `data` by
    // reference, and must not be able to redirect where the next page comes
    // from. The hook here deletes the cursor before returning; paging must
    // continue anyway.
    const seen: string[] = [];
    const ctx = cursorCtx(
      {
        "": { results: [{ id: 1 }], paging: { next: { after: "TOK1" } } },
        TOK1: { results: [{ id: 2 }] },
      },
      seen,
    );
    const out = (await runTool(entry, cursorTool, {}, ctx, {
      paginate: (data) => {
        delete (data as Record<string, unknown>).paging;
        return { items: ((data as Record<string, Json[]>).results ?? []) as Json[] };
      },
    })) as Record<string, unknown>;

    expect(new URL(seen[1]).searchParams.get("after")).toBe("TOK1");
    expect(out.items).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("hands the outstanding cursor to a buildRequest hook", async () => {
    const cursors: Array<string | undefined> = [];
    const ctx = cursorCtx({
      "": { results: [{ id: 1 }], paging: { next: { after: "TOK1" } } },
      TOK1: { results: [{ id: 2 }] },
    });
    await runTool(entry, cursorTool, {}, ctx, {
      buildRequest: (_tool, _args, _ctx, info) => {
        cursors.push(info.cursor);
        const url = new URL("https://sf.test/v1/crm/v3/objects/contacts");
        if (info.cursor !== undefined) url.searchParams.set("after", info.cursor);
        return { method: "GET", url: url.toString(), headers: {} };
      },
    });
    expect(cursors).toEqual([undefined, "TOK1"]);
  });
});

describe("runTool POST search bodies", () => {
  // HubSpot's shape: filters in the body, cursor and limit in the body too.
  const searchTool: ToolDef = {
    name: "contact_search",
    description: "d",
    input: {
      type: "object",
      properties: { email: { type: "string" }, lastname: { type: "string" } },
    },
    request: {
      method: "POST",
      path: "/crm/v3/objects/contacts/search",
      body: {
        filterGroups: [
          {
            filters: [
              { propertyName: "email", operator: "EQ", value: "{{email}}" },
              { propertyName: "lastname", operator: "CONTAINS_TOKEN", value: "{{lastname}}" },
            ],
          },
        ],
        properties: ["firstname", "email"],
      },
    },
    list: {
      itemsAt: "results",
      pagination: {
        style: "cursor",
        perPage: 100,
        maxPages: 2,
        in: "body",
        cursorAt: "paging.next.after",
      },
      dedupeBy: "id",
    },
  };

  /** Captures each request's method and parsed JSON body. */
  function captureCtx(responses: unknown[]): {
    ctx: AdapterContext;
    sent: Array<{ method: string; body: Record<string, unknown> }>;
  } {
    const sent: Array<{ method: string; body: Record<string, unknown> }> = [];
    let i = 0;
    const ctx: AdapterContext = {
      ...ctxWith({}),
      http: {
        request: async (_url, init) => {
          sent.push({
            method: String(init.method),
            body: JSON.parse(String(init.body)) as Record<string, unknown>,
          });
          return { status: 200, data: responses[i++] ?? { results: [] }, raw: "" };
        },
      },
    };
    return { ctx, sent };
  }

  it("POSTs the interpolated filter body with a JSON content type", async () => {
    const seenHeaders: Array<Record<string, string>> = [];
    const { ctx, sent } = captureCtx([{ results: [{ id: 1 }] }]);
    const wrapped: AdapterContext = {
      ...ctx,
      http: {
        request: async (url, init) => {
          seenHeaders.push(init.headers as Record<string, string>);
          return ctx.http.request(url, init);
        },
      },
    };

    await runTool(entry, searchTool, { email: "a@b.test", lastname: "Smith" }, wrapped);

    expect(sent[0].method).toBe("POST");
    expect(seenHeaders[0]["Content-Type"]).toBe("application/json");
    expect(sent[0].body.filterGroups).toEqual([
      {
        filters: [
          { propertyName: "email", operator: "EQ", value: "a@b.test" },
          { propertyName: "lastname", operator: "CONTAINS_TOKEN", value: "Smith" },
        ],
      },
    ]);
  });

  it("drops a whole filter whose argument was not supplied, never a single key of it", async () => {
    // Dropping only `value` would leave {propertyName, operator} — a filter
    // that means something different from what the config declares.
    const { ctx, sent } = captureCtx([{ results: [{ id: 1 }] }]);
    await runTool(entry, searchTool, { lastname: "Smith" }, ctx);

    expect(sent[0].body.filterGroups).toEqual([
      { filters: [{ propertyName: "lastname", operator: "CONTAINS_TOKEN", value: "Smith" }] },
    ]);
  });

  it("collapses to an unfiltered search when no argument is supplied", async () => {
    // Every branch drops, so filterGroups empties out and is omitted entirely
    // rather than sent as [{filters: []}], which HubSpot rejects.
    const { ctx, sent } = captureCtx([{ results: [{ id: 1 }] }]);
    await runTool(entry, searchTool, {}, ctx);

    expect(sent[0].body).not.toHaveProperty("filterGroups");
    expect(sent[0].body.properties).toEqual(["firstname", "email"]);
  });

  it("puts limit and the cursor in the body, not the query string", async () => {
    const seenUrls: string[] = [];
    const { ctx, sent } = captureCtx([
      { results: [{ id: 1 }], paging: { next: { after: "TOK1" } } },
      { results: [{ id: 2 }] },
    ]);
    const wrapped: AdapterContext = {
      ...ctx,
      http: {
        request: async (url, init) => {
          seenUrls.push(url);
          return ctx.http.request(url, init);
        },
      },
    };

    const out = (await runTool(entry, searchTool, { email: "a@b.test" }, wrapped)) as Record<string, unknown>;

    expect(sent[0].body.limit).toBe(100);
    expect(sent[0].body).not.toHaveProperty("after");
    expect(sent[1].body.after).toBe("TOK1");
    // HubSpot ignores these on the query string; sending them there would
    // re-fetch page one forever.
    expect(new URL(seenUrls[1]).searchParams.has("after")).toBe(false);
    expect(out.items).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("preserves argument types rather than stringifying them", async () => {
    const typedTool: ToolDef = {
      ...searchTool,
      request: {
        method: "POST",
        path: "/crm/v3/objects/contacts/search",
        body: { score: "{{score}}", flag: "{{flag}}", tags: "{{tags}}", label: "n={{score}}" },
      },
    };
    const { ctx, sent } = captureCtx([{ results: [{ id: 1 }] }]);
    await runTool(entry, typedTool, { score: 42, flag: true, tags: ["a", "b"] }, ctx);

    expect(sent[0].body.score).toBe(42);
    expect(sent[0].body.flag).toBe(true);
    expect(sent[0].body.tags).toEqual(["a", "b"]);
    // Embedded among other text, it is still string interpolation.
    expect(sent[0].body.label).toBe("n=42");
  });

  it("refuses an object-valued argument rather than splicing caller structure into the request", async () => {
    const typedTool: ToolDef = {
      ...searchTool,
      request: {
        method: "POST",
        path: "/crm/v3/objects/contacts/search",
        body: { filterGroups: "{{injected}}" },
      },
    };
    await expect(
      runTool(entry, typedTool, { injected: { filters: [{ propertyName: "x" }] } } as unknown as Json, ctxWith({})),
    ).rejects.toThrow(/must not be an object/);
  });

  it("sends no body and no JSON content type for a GET tool", async () => {
    const seen: Array<RequestInit> = [];
    const ctx: AdapterContext = {
      ...ctxWith({}),
      http: {
        request: async (_url, init) => {
          seen.push(init);
          return { status: 200, data: { items: [] }, raw: "" };
        },
      },
    };
    await runTool(entry, tool, { name: "Acme" }, ctx);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].body).toBeUndefined();
    expect((seen[0].headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });
});

describe("runTool write dispatch", () => {
  const updateTool: ToolDef = {
    name: "contact_update",
    description: "d",
    input: {
      type: "object",
      properties: { contactId: { type: "string" }, fields: { type: "object" } },
      required: ["contactId", "fields"],
    },
    request: {
      method: "PATCH",
      path: "/crm/v3/objects/contacts/{{contactId}}",
      body: { properties: "{{fields}}" },
    },
    write: { fieldsFrom: "fields" },
  };

  function captureCtx(): {
    ctx: AdapterContext;
    calls: Array<{ url: string; method: string; body: string; opts: unknown }>;
  } {
    const calls: Array<{ url: string; method: string; body: string; opts: unknown }> = [];
    const ctx: AdapterContext = {
      ...ctxWith({}),
      http: {
        request: async (url, init, opts) => {
          calls.push({ url, method: String(init.method), body: String(init.body), opts });
          return { status: 200, data: { id: "151" }, raw: "" };
        },
      },
    };
    return { ctx, calls };
  }

  it("PATCHes the field bag to the interpolated path", async () => {
    const { ctx, calls } = captureCtx();
    await runTool(entry, updateTool, { contactId: "151", fields: { firstname: "Ada" } }, ctx);

    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe("https://sf.test/v1/crm/v3/objects/contacts/151");
    expect(JSON.parse(calls[0].body)).toEqual({ properties: { firstname: "Ada" } });
  });

  it("supports a reviewed field bag as the entire JSON body", async () => {
    const rootBodyTool: ToolDef = {
      ...updateTool,
      name: "customer_create",
      request: { method: "POST", path: "/customers", body: "{{fields}}" },
    };
    const { ctx, calls } = captureCtx();
    const fields = {
      customer_name: "Ada Lovelace",
      contacts: [{ fname: "Ada", lname: "Lovelace" }],
    };

    await runTool(entry, rootBodyTool, { fields }, ctx);

    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body)).toEqual(fields);
  });

  it("narrows retry to 429 for a write, so a 5xx is never double-submitted", async () => {
    // The app's own transport config is irrelevant here — retry is configured
    // per APP, so a config author narrowing it for a write tool would also
    // narrow it for every read tool beside it. The runtime enforces this from
    // the tool's `write` block instead.
    const { ctx, calls } = captureCtx();
    await runTool(entry, updateTool, { contactId: "151", fields: { firstname: "Ada" } }, ctx);
    expect(calls[0].opts).toEqual({ retryOn: ["429"] });
  });

  it("leaves a read tool on the app's configured retry policy", async () => {
    const { ctx, calls } = captureCtx();
    await runTool(entry, { ...updateTool, name: "contact_get", write: undefined, request: { method: "GET", path: "/crm/v3/objects/contacts/{{contactId}}" } }, { contactId: "151" }, ctx);
    expect(calls[0].opts).toBeUndefined();
  });

  it("accepts an object ONLY for the argument the write block names", async () => {
    // The structure-injection guard is lifted for `fields` because the write
    // allowlist governs its keys; it still stands for every other argument.
    const twoBags: ToolDef = {
      ...updateTool,
      request: {
        method: "PATCH",
        path: "/crm/v3/objects/contacts/{{contactId}}",
        body: { properties: "{{fields}}", associations: "{{extra}}" },
      },
    };
    const { ctx } = captureCtx();
    await expect(
      runTool(entry, twoBags, { contactId: "151", fields: { firstname: "Ada" }, extra: { a: 1 } } as unknown as Json, ctx),
    ).rejects.toThrow(/must not be an object/);
  });

  it("rejects a scalar supplied where the write block expects a field object", async () => {
    const { ctx } = captureCtx();
    await expect(
      runTool(entry, updateTool, { contactId: "151", fields: "firstname=Ada" }, ctx),
    ).rejects.toThrow(/must be an object of fields/);
  });
});

describe("runTool with auth type none", () => {
  const noAuthEntry = {
    ...entry,
    org: "demo", app: "public",
    config: { ...entry.config, app: "public", auth: { type: "none" } },
  } as unknown as AppEntry;

  it("sends no Authorization header and never mints a token", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("no token endpoint may be called for auth type none");
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
    let headers: Record<string, string> | undefined;
    const ctx: AdapterContext = {
      ...ctxWith({}),
      config: noAuthEntry.config,
      http: {
        request: async (_url, init) => {
          headers = init?.headers as Record<string, string>;
          return { status: 200, data: { items: [{ id: 1 }] }, raw: "" };
        },
      },
    };
    await runTool(noAuthEntry, tool, {}, ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(headers).toBeDefined();
    expect(Object.keys(headers!).map((h) => h.toLowerCase())).not.toContain("authorization");
  });
});
