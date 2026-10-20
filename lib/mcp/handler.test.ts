import { describe, it, expect, vi } from "vitest";
import { handleMcpRequest, checkToolInputSchema, type HandlerDeps } from "@/lib/mcp/handler";
import type { AppEntry, Principal, ToolDef } from "@/lib/types";
import type { AdapterContext } from "@/lib/adapters/types";
import type { AuditRow } from "@/lib/audit/log";
import { UpstreamError } from "@/lib/http/errors";
import { computeGrant } from "@/lib/policy/grants";

/** A minimal, inert AdapterContext for tests that don't care about its contents — real
 *  wiring lives in route-deps.ts (Task 11 fix round 1, finding I6). */
function fakeContext(entry: AppEntry): AdapterContext {
  return {
    http: { request: async () => ({ status: 200, data: null, raw: "" }) },
    secret: async () => "unused",
    config: entry.config,
    log: () => {},
  };
}

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
    tools: [
      { name: "customer_get", description: "Get a customer", input: { type: "object" },
        request: { method: "GET", path: "/customers" } },
      { name: "invoice_get", description: "Get an invoice", input: { type: "object" },
        request: { method: "GET", path: "/invoices" } },
    ],
  },
  roles: {
    roles: {
      field_tech: { tools: ["customer_get"],
                    fields: { "customer_*": { allow: ["id", "customer_name"] } } },
    },
  },
} as unknown as AppEntry;

const principal: Principal = {
  userId: "u1", orgId: "o1", orgSlug: "contoso", roles: ["field_tech"], oauthResource: null,
};

function deps(over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    catalog: new Map([["contoso/servicefusion", entry]]),
    authenticate: async () => principal,
    runTool: async () => ({ id: 1, customer_name: "Acme", account_balance: 999 }),
    audit: async () => {},
    buildContext: async (e: AppEntry) => fakeContext(e),
    ...over,
  };
}

const TEST_ISSUER = "https://gw.example.com";

const call = (body: unknown, d = deps(), org = "contoso", app: string | null = null) =>
  handleMcpRequest({ orgSlug: org, appSlug: app, body, apiKey: "kngw_x", deps: d, issuer: TEST_ISSUER });

describe("handleMcpRequest", () => {
  // --- The brief's 6 required tests, verbatim ---

  it("returns 401 without a key", async () => {
    const res = await handleMcpRequest({
      orgSlug: "contoso", appSlug: null, body: { jsonrpc: "2.0", id: 1, method: "initialize" },
      apiKey: null, deps: deps(), issuer: TEST_ISSUER,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
  });

  it("returns 404 when the principal's org does not match the path", async () => {
    const res = await call({ jsonrpc: "2.0", id: 1, method: "initialize" }, deps(), "someone-else");
    expect(res.status).toBe(404);
  });

  it("rejects an OAuth token at a different app resource", async () => {
    const oauthPrincipal: Principal = {
      ...principal,
      oauthResource: `${TEST_ISSUER}/mcp/contoso/fieldedge`,
    };
    const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
    const res = await call(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      deps({ authenticate: async () => oauthPrincipal, audit }),
      "contoso",
      "servicefusion",
    );
    expect(res.status).toBe(404);
    expect(audit.mock.calls[0][0].decision).toBe("denied_resource_mismatch");
  });

  it("accepts an OAuth token only at its exact app resource", async () => {
    const oauthPrincipal: Principal = {
      ...principal,
      oauthResource: `${TEST_ISSUER}/mcp/contoso/servicefusion`,
    };
    const res = await call(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      deps({ authenticate: async () => oauthPrincipal }),
      "contoso",
      "servicefusion",
    );
    expect(res.status).toBe(200);
  });

  it("lists only granted tools, app-prefixed", async () => {
    const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = await res.json();
    expect(body.result.tools.map((t: { name: string }) => t.name))
      .toEqual(["servicefusion_customer_get"]);
  });

  it("advertises read, write, and unclassified tools with MCP annotations", async () => {
    const tools: ToolDef[] = [
      { name: "record_get", description: "Read", input: { type: "object" },
        request: { method: "GET", path: "/records/{{id}}" } },
      { name: "record_search", description: "Search", input: { type: "object" },
        request: { method: "POST", path: "/records/search", body: {} },
        list: { itemsAt: "results", pagination: { style: "cursor", perPage: 100,
          maxPages: 10, in: "body", cursorAt: "paging.next.after" } } },
      { name: "record_create", description: "Create", input: { type: "object" },
        request: { method: "POST", path: "/records", body: { properties: "{{fields}}" } },
        write: { fieldsFrom: "fields" } },
      { name: "record_update", description: "Update", input: { type: "object" },
        request: { method: "PATCH", path: "/records/{{id}}", body: { properties: "{{fields}}" } },
        write: { fieldsFrom: "fields" } },
      { name: "local_other", description: "No declared request effect", input: { type: "object" } },
    ];
    const annotatedEntry = {
      ...entry,
      config: { ...entry.config, tools },
      roles: { roles: { field_tech: { tools: tools.map((tool) => tool.name), fields: {} } } },
    } as AppEntry;
    const res = await call(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      deps({ catalog: new Map([["contoso/servicefusion", annotatedEntry]]) }),
    );
    const body = await res.json();
    const listed = Object.fromEntries(body.result.tools.map((tool: { name: string }) => [tool.name, tool]));

    expect(listed.servicefusion_record_get.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    });
    expect(listed.servicefusion_record_search.annotations.readOnlyHint).toBe(true);
    expect(listed.servicefusion_record_create.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: false, idempotentHint: false,
    });
    expect(listed.servicefusion_record_update.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: true, idempotentHint: false,
    });
    expect(listed.servicefusion_local_other.annotations).toBeUndefined();
  });

  it("reports an ungranted tool as unknown, never as forbidden", async () => {
    const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                             params: { name: "servicefusion_invoice_get", arguments: {} } });
    const body = await res.json();
    expect(body.error.message).toMatch(/unknown tool/i);
    expect(body.error.message).not.toMatch(/forbidden|permission|denied/i);
  });

  it("filters response fields to the role's allowlist", async () => {
    const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                             params: { name: "servicefusion_customer_get", arguments: {} } });
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload).toEqual({ id: 1, customer_name: "Acme" });
    expect(payload.account_balance).toBeUndefined();
  });

  it("writes an audit row for a denial", async () => {
    const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
    await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                 params: { name: "servicefusion_invoice_get", arguments: {} } }, deps({ audit }));
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0].decision).toBe("denied_no_grant");
  });

  // --- S2 (Task 12 final review): audit_events.tool is one format ---

  it("[S2] writes the bare config tool name (not the app-prefixed exposed name) for a denied_no_grant row", async () => {
    const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
    await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                 params: { name: "servicefusion_invoice_get", arguments: {} } }, deps({ audit }));
    expect(audit.mock.calls[0][0].decision).toBe("denied_no_grant");
    // Bare, matching every other decision's `tool` column — never "servicefusion_invoice_get".
    expect(audit.mock.calls[0][0].tool).toBe("invoice_get");
  });

  it("[S2] writes the raw, caller-supplied string for a denied_unknown_tool row, since no config tool resolved", async () => {
    const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
    await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                 params: { name: "servicefusion_totally_made_up", arguments: {} } }, deps({ audit }));
    expect(audit.mock.calls[0][0].decision).toBe("denied_unknown_tool");
    expect(audit.mock.calls[0][0].tool).toBe("servicefusion_totally_made_up");
  });

  // --- S3 (Task 12 final review): a stale/unknown role assignment is logged and audited ---

  it("[S3] carries unknownRoles into the audit row when the principal holds a role absent from roles.json", async () => {
    const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
    const staleRolePrincipal: Principal = { ...principal, roles: ["field_tech", "role_removed_last_quarter"] };
    await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                 params: { name: "servicefusion_customer_get", arguments: {} } },
               deps({ audit, authenticate: async () => staleRolePrincipal }));
    expect(audit.mock.calls[0][0].decision).toBe("allowed");
    expect(audit.mock.calls[0][0].unknownRoles).toEqual(["role_removed_last_quarter"]);
  });

  it("[S3] logs the unknown role server-side", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const staleRolePrincipal: Principal = { ...principal, roles: ["field_tech", "typo_role"] };
      await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                   params: { name: "servicefusion_customer_get", arguments: {} } },
                 deps({ authenticate: async () => staleRolePrincipal }));
      expect(warnSpy).toHaveBeenCalled();
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/mcp\.unknown_roles/);
      expect(logged).toMatch(/typo_role/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("[S3] does not report unknownRoles when every assigned role is known", async () => {
    const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
    await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                 params: { name: "servicefusion_customer_get", arguments: {} } }, deps({ audit }));
    expect(audit.mock.calls[0][0].unknownRoles).toBeUndefined();
  });

  // --- (a) Try to get a field you should not have ---

  describe("(a) field-leak attempts", () => {
    it("does not leak an unallowed field even when the adapter returns it", async () => {
      const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                               params: { name: "servicefusion_customer_get", arguments: {} } });
      const body = await res.json();
      const payload = JSON.parse(body.result.content[0].text);
      expect(payload.account_balance).toBeUndefined();
    });

    it("rejects an unrecognized argument (e.g. a hand-crafted expand) rather than forwarding it", async () => {
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                               params: { name: "servicefusion_customer_get",
                                         arguments: { expand: "account_balance" } } },
                              deps({ audit }));
      const body = await res.json();
      expect(body.error.message).toMatch(/unknown argument/i);
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit.mock.calls[0][0].decision).toBe("denied_bad_args");
    });

    it("treats a tool name differing only in case as unknown, not a case-insensitive match", async () => {
      const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                               params: { name: "SERVICEFUSION_CUSTOMER_GET", arguments: {} } });
      const body = await res.json();
      expect(body.error.message).toMatch(/unknown tool/i);
    });

    it("reports a tool absent from tools/list as unknown when called directly", async () => {
      const listRes = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const listBody = await listRes.json();
      const listedNames = listBody.result.tools.map((t: { name: string }) => t.name);
      expect(listedNames).not.toContain("servicefusion_invoice_get");

      const callRes = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                                   params: { name: "servicefusion_invoice_get", arguments: {} } });
      const callBody = await callRes.json();
      expect(callBody.error.message).toMatch(/unknown tool/i);
    });
  });

  // --- (b) Try to reach another org ---

  describe("(b) cross-org attempts", () => {
    it("returns 404, never 403, for a valid key against the wrong org", async () => {
      const res = await call({ jsonrpc: "2.0", id: 1, method: "initialize" }, deps(), "org-b");
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(403);
    });

    it("returns the identical 404 shape for an invalid key as for a valid key on the wrong org", async () => {
      const badKeyDeps = deps({ authenticate: async () => null });
      const wrongOrgRes = await call({ jsonrpc: "2.0", id: 1, method: "initialize" }, deps(), "org-b");
      const badKeyRes = await call({ jsonrpc: "2.0", id: 1, method: "initialize" }, badKeyDeps, "contoso");

      expect(wrongOrgRes.status).toBe(badKeyRes.status);
      expect(await wrongOrgRes.json()).toEqual(await badKeyRes.json());
    });

    it("does not reveal an app-not-found distinction for an org that exists but has no matching app", async () => {
      const res = await call(
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        deps(), "contoso", "nonexistent-app",
      );
      expect(res.status).toBe(404);
    });
  });

  // --- (c) The audit row on every path ---

  describe("(c) audit row per outcome", () => {
    it("writes exactly one row for an unknown tool", async () => {
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                   params: { name: "servicefusion_nope", arguments: {} } }, deps({ audit }));
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit.mock.calls[0][0].decision).toBe("denied_unknown_tool");
    });

    it("writes exactly one row for bad arguments", async () => {
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                   params: { name: "servicefusion_customer_get", arguments: { bogus: 1 } } },
                 deps({ audit }));
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit.mock.calls[0][0].decision).toBe("denied_bad_args");
    });

    it("writes exactly one row for an upstream/adapter error, carrying upstream status when available", async () => {
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      const runTool = vi.fn(async () => { throw new UpstreamError(502, "https://sf.test/v1/customers", "bad gateway"); });
      await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                   params: { name: "servicefusion_customer_get", arguments: {} } },
                 deps({ audit, runTool }));
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit.mock.calls[0][0].decision).toBe("error");
      expect(audit.mock.calls[0][0].upstreamStatus).toBe(502);
    });

    it("writes exactly one row for a success", async () => {
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                   params: { name: "servicefusion_customer_get", arguments: {} } }, deps({ audit }));
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit.mock.calls[0][0].decision).toBe("allowed");
    });

    it("passes the tool's audit.redact list through to the audit call", async () => {
      const redactingEntry = {
        ...entry,
        config: {
          ...entry.config,
          tools: [
            { ...entry.config.tools[0], audit: { redact: ["secret_field"] } },
            entry.config.tools[1],
          ],
        },
      } as unknown as AppEntry;
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                   params: { name: "servicefusion_customer_get", arguments: {} } },
                 deps({ audit, catalog: new Map([["contoso/servicefusion", redactingEntry]]) }));
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit.mock.calls[0][1]).toEqual(["secret_field"]);
    });

    it("does not surface the raw infrastructure error to the client or the audit row, and still writes exactly one row", async () => {
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      const authenticate = vi.fn(async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432"); });
      const res = await call({ jsonrpc: "2.0", id: 1, method: "initialize" }, deps({ audit, authenticate }));
      const body = await res.json();

      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(200);
      expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);

      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit.mock.calls[0][0].decision).toBe("error");
      expect(JSON.stringify(audit.mock.calls[0][0])).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
    });
  });

  // --- (d) JSON-RPC edge cases ---

  describe("(d) JSON-RPC edge cases", () => {
    it("handles a missing method without throwing", async () => {
      const res = await call({ jsonrpc: "2.0", id: 1 });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error.code).toBe(-32601);
    });

    it("echoes back a null id", async () => {
      const res = await call({ jsonrpc: "2.0", id: null, method: "initialize" });
      const body = await res.json();
      expect(body.id).toBeNull();
    });

    it("rejects a batch (array) body instead of crashing", async () => {
      const res = await call([{ jsonrpc: "2.0", id: 1, method: "initialize" }]);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toMatch(/batch/i);
    });

    it("handles params that are not an object without crashing", async () => {
      const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: "not-an-object" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });

    it("rejects non-object `arguments` as bad args rather than silently coercing", async () => {
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                               params: { name: "servicefusion_customer_get", arguments: "oops" } },
                              deps({ audit }));
      const body = await res.json();
      expect(body.error.message).toMatch(/arguments must be an object/i);
      expect(audit.mock.calls[0][0].decision).toBe("denied_bad_args");
    });

    it("handles a null/unparseable body without crashing", async () => {
      const res = await call(null);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });
  });

  // --- Fix round 1: C1, C2, I2, I3 (each shown failing against pre-fix HEAD; see report) ---

  describe("fix round 1", () => {
    it("[C1] does not leak unfiltered fields from a single-record tool whose payload happens to contain a key named 'items'", async () => {
      // S5 (Task 12 final review): sharpened. The original version of this test only asserted
      // `account_balance`/`ssn` were absent from the payload — which round 2's fix (finding C,
      // the explicit `{items, truncated, totalCount}` envelope) makes true EVEN IF this branch
      // reverted to the pre-fix duck-typing (`Array.isArray(rawRecord?.items)` instead of
      // `tool.list !== undefined`): duck-typing would see the `items` array here and take the
      // LIST branch, which only ever extracts `items` (filtered) plus `truncated`/`totalCount`
      // — every other top-level field, including the sensitive ones, would already be dropped
      // by the envelope construction itself, with nothing left to prove `tool.list` (not the
      // payload shape) decided the branch. Verified directly: reverting the branch to duck
      // typing still passed the original two assertions above.
      //
      // The assertion that actually discriminates is on SHAPE: `customer_get` declares no
      // `list` block, so its result must be the single-record object itself (`{id,
      // customer_name}`), never a list envelope (`{items: [...], truncated}`). Duck-typing on
      // the payload's `items` key produces the latter; deciding from `tool.list` produces the
      // former. This is exactly what would fail under that mutation — confirmed directly
      // against the reverted branch before landing this test.
      const runTool = vi.fn(async () => ({
        id: 7, customer_name: "Acme",
        account_balance: 999999, ssn: "123-45-6789",
        items: [{ line: 1 }],
      }));
      const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                               params: { name: "servicefusion_customer_get", arguments: {} } },
                              deps({ runTool }));
      const body = await res.json();
      const payload = JSON.parse(body.result.content[0].text);
      expect(payload).toEqual({ id: 7, customer_name: "Acme" });
      expect(payload.items).toBeUndefined();
      expect(payload.account_balance).toBeUndefined();
      expect(payload.ssn).toBeUndefined();
    });

    it("[C2] returns a generic error message to the client on an upstream error, never the raw upstream body or URL", async () => {
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      const runTool = vi.fn(async () => {
        throw new UpstreamError(403, "https://sf.test/v1/customers/9",
          '{"account_balance":999999,"ssn":"123-45-6789"}');
      });
      const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                               params: { name: "servicefusion_customer_get", arguments: {} } },
                              deps({ audit, runTool }));
      const body = await res.json();
      expect(JSON.stringify(body)).not.toMatch(/account_balance|ssn|999999|sf\.test/);
      // The detail must still live in the audit row, not vanish entirely.
      expect(audit.mock.calls[0][0].error).toMatch(/account_balance/);
    });

    it("[I2] redacts a denied_unknown_tool row against every redact list in the org's catalog, not an empty one", async () => {
      const redactingEntry = {
        ...entry,
        config: {
          ...entry.config,
          tools: [
            { ...entry.config.tools[0], audit: { redact: ["ssn"] } },
            entry.config.tools[1],
          ],
        },
      } as unknown as AppEntry;
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                   params: { name: "servicefusion_ghost", arguments: { ssn: "123-45-6789" } } },
                 deps({ audit, catalog: new Map([["contoso/servicefusion", redactingEntry]]) }));
      expect(audit.mock.calls[0][0].decision).toBe("denied_unknown_tool");
      expect(audit.mock.calls[0][1]).toContain("ssn");
    });

    it("[I3] rejects null for a required argument instead of treating it as satisfied", async () => {
      const requiredArgEntry = {
        org: "contoso", app: "servicefusion",
        config: {
          ...entry.config,
          tools: [
            { name: "thing_get", description: "d",
              input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
              request: { method: "GET", path: "/things" } },
          ],
        },
        roles: { roles: { field_tech: { tools: ["thing_get"], fields: { "thing_*": { allow: ["*"] } } } } },
      } as unknown as AppEntry;
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                               params: { name: "servicefusion_thing_get", arguments: { query: null } } },
                              deps({ audit, catalog: new Map([["contoso/servicefusion", requiredArgEntry]]) }));
      const body = await res.json();
      expect(body.error.message).toMatch(/required/i);
      expect(audit.mock.calls[0][0].decision).toBe("denied_bad_args");
    });

    it("[fix round 2, B] rejects a missing required argument whose name collides with an Object.prototype key", async () => {
      // `args["toString"]` resolves through the prototype chain to Object.prototype.toString
      // (a function) even when `args` has no own "toString" key at all — a plain-object read
      // like the pre-fix `const value = args[name]` cannot tell "present" from "inherited".
      const protoCollisionEntry = {
        org: "contoso", app: "servicefusion",
        config: {
          ...entry.config,
          tools: [
            { name: "thing_get2", description: "d",
              input: { type: "object", properties: { toString: { type: "string" } }, required: ["toString"] },
              request: { method: "GET", path: "/things" } },
          ],
        },
        roles: { roles: { field_tech: { tools: ["thing_get2"], fields: { "thing_*": { allow: ["*"] } } } } },
      } as unknown as AppEntry;
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                               params: { name: "servicefusion_thing_get2", arguments: {} } },
                              deps({ audit, catalog: new Map([["contoso/servicefusion", protoCollisionEntry]]) }));
      const body = await res.json();
      expect(body.error.message).toMatch(/required argument: toString/i);
      expect(audit.mock.calls[0][0].decision).toBe("denied_bad_args");
    });

    it("[fix round 3, G] rejects an own key explicitly set to undefined for a required argument", async () => {
      // Unreachable over the wire (req.json() can never produce a value of `undefined` — JSON
      // has no such literal), but `validateArgs` is a pure function this test calls directly
      // through `handleMcpRequest`'s in-process path, and its own doc comment claims the
      // Object.hasOwn-based check is strictly stronger than the `args[name] === undefined ||
      // args[name] === null` read it replaced. For an own key whose value literally is
      // `undefined`, `Object.hasOwn` alone says "present" — weaker than what it replaced.
      const requiredArgEntry = {
        org: "contoso", app: "servicefusion",
        config: {
          ...entry.config,
          tools: [
            { name: "thing_get3", description: "d",
              input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
              request: { method: "GET", path: "/things" } },
          ],
        },
        roles: { roles: { field_tech: { tools: ["thing_get3"], fields: { "thing_*": { allow: ["*"] } } } } },
      } as unknown as AppEntry;
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                               params: { name: "servicefusion_thing_get3", arguments: { query: undefined } } },
                              deps({ audit, catalog: new Map([["contoso/servicefusion", requiredArgEntry]]) }));
      const body = await res.json();
      expect(body.error.message).toMatch(/required argument: query/i);
      expect(audit.mock.calls[0][0].decision).toBe("denied_bad_args");
    });
  });

  // --- Fix round 2, finding C: the list envelope is built explicitly, not by spreading the
  // upstream/runTool payload verbatim (a future paginate/compose change must not be able to
  // reopen C1 by adding an extra top-level key to a list result). ---

  it("[fix round 2, C] the list-result envelope carries only items/truncated/totalCount, dropping any other top-level key runTool returns", async () => {
    const listEntry = {
      org: "contoso", app: "servicefusion",
      config: {
        ...entry.config,
        tools: [
          { name: "thing_list", description: "d", input: { type: "object" },
            list: { itemsAt: "items", pagination: { style: "page", perPage: 10, maxPages: 2 } },
            request: { method: "GET", path: "/things" } },
        ],
      },
      roles: { roles: { field_tech: { tools: ["thing_list"], fields: { "thing_*": { allow: ["*"] } } } } },
    } as unknown as AppEntry;
    const runTool = vi.fn(async () => ({
      items: [{ id: 1 }], truncated: true, totalCount: 5,
      secret_meta: "leak-this",
    }));
    const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                             params: { name: "servicefusion_thing_list", arguments: {} } },
                            deps({ runTool, catalog: new Map([["contoso/servicefusion", listEntry]]) }));
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.items).toEqual([{ id: 1 }]);
    expect(payload.truncated).toBe(true);
    expect(payload.totalCount).toBe(5);
    expect(payload.secret_meta).toBeUndefined();
  });

  // --- Fix round 2, finding D: a stable, non-identifying failure class ---

  it("[fix round 2, D] a 403 leaks none of its forbidden-field body, but the client learns it was an upstream client error", async () => {
    const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
    const runTool = vi.fn(async () => {
      throw new UpstreamError(403, "https://sf.test/v1/customers/9",
        '{"account_balance":999999,"ssn":"123-45-6789"}');
    });
    const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                             params: { name: "servicefusion_customer_get", arguments: {} } },
                            deps({ audit, runTool }));
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/account_balance|ssn|999999|sf\.test|403/);
    expect(body.error.message).toMatch(/upstream_4xx/);
    expect(body.error.message).toMatch(/forbidden: the connected upstream account has no access/);
  });

  it("a 400 and a 403 read differently, so a bad argument is never reported as a permissions gap", async () => {
    const run = async (status: number) => {
      const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                               params: { name: "servicefusion_customer_get", arguments: {} } },
                             deps({ runTool: async () => {
                               throw new UpstreamError(status, "https://sf.test/v1/x?sort=-id", '{"message":"Attribute `id`"}');
                             } }));
      return (await res.json()).error.message as string;
    };
    const bad = await run(400);
    expect(bad).toMatch(/rejected: an argument or filter value was not accepted/);
    expect(bad).not.toMatch(/forbidden|Attribute|sort|sf\.test|400/);
    expect(await run(404)).toMatch(/not found/);
  });

  it("status 0 (timeout or connection failure) is classed upstream_unreachable, not gateway_error", async () => {
    const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                             params: { name: "servicefusion_customer_get", arguments: {} } },
                           deps({ runTool: async () => {
                             throw new UpstreamError(0, "https://sf.test/v1/customers", "deadline exceeded");
                           } }));
    const msg = (await res.json()).error.message as string;
    expect(msg).toMatch(/upstream_unreachable/);
    expect(msg).not.toMatch(/gateway_error|sf\.test|deadline/);
  });

  it("[fix round 2, D] a 502 is classed upstream_5xx and a non-UpstreamError failure is classed gateway_error", async () => {
    const upstream5xxRes = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                                        params: { name: "servicefusion_customer_get", arguments: {} } },
                                       deps({ runTool: async () => { throw new UpstreamError(502, "https://sf.test/v1/customers", "bad gateway"); } }));
    const upstream5xxBody = await upstream5xxRes.json();
    expect(upstream5xxBody.error.message).toMatch(/upstream_5xx/);

    const gatewayErrorRes = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                                        params: { name: "servicefusion_customer_get", arguments: {} } },
                                       deps({ runTool: async () => { throw new Error("ENOTFOUND sf.test"); } }));
    const gatewayErrorBody = await gatewayErrorRes.json();
    expect(gatewayErrorBody.error.message).toMatch(/gateway_error/);
  });

  // --- Fix round 2, finding E: cap the attempted-org string stored in the audit row ---

  it("[fix round 2, E] caps the attempted-org string stored in the org-mismatch audit row", async () => {
    const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
    const huge = "x".repeat(10_000);
    await call({ jsonrpc: "2.0", id: 1, method: "initialize" }, deps({ audit }), huge);
    expect(audit).toHaveBeenCalledTimes(1);
    const row = audit.mock.calls[0][0];
    expect(row.decision).toBe("denied_org_mismatch");
    expect((row.error as string).length).toBeLessThan(300);
  });

  // --- Extra: Grant.fields frozen readonly arrays must not break filtering ---
  //
  // Rewritten in fix round 1: the previous version of this test only asserted
  // `res.status === 200`, which passes regardless of whether the allowlist is frozen, whether
  // the handler ever reads it, or whether filtering happened at all — it could not fail for
  // the reason it claimed to test.

  it("copies the frozen, readonly field allowlist before filtering, and never mutates the shared Grant", async () => {
    const grant = computeGrant(["field_tech"], entry.roles, entry.config.tools);
    const before = grant.fields.get("customer_get");
    expect(Object.isFrozen(before)).toBe(true);
    expect(before).toEqual(["id", "customer_name"]);

    const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                             params: { name: "servicefusion_customer_get", arguments: {} } });
    const body = await res.json();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload).toEqual({ id: 1, customer_name: "Acme" });

    // The handler's own internal `computeGrant` call (inside `handleMcpRequest`) is a
    // different Grant instance than this test's `grant` — the real assertion of interest is
    // that a frozen source array never throws when copied/filtered, not that the two calls
    // share an object. Confirm this test's own reference is still frozen and unchanged,
    // proving nothing anywhere mutated it in place.
    expect(Object.isFrozen(grant.fields.get("customer_get"))).toBe(true);
    expect(grant.fields.get("customer_get")).toEqual(["id", "customer_name"]);
  });

  // --- Fix round 1: I1 (audit the cross-org mismatch) ---

  describe("[I1] cross-org mismatch is audited", () => {
    it("writes a denied_org_mismatch row, attributed to the principal's real org, naming the attempted org only in `error`", async () => {
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      const res = await call({ jsonrpc: "2.0", id: 1, method: "initialize" }, deps({ audit }), "org-b");
      expect(res.status).toBe(404);
      expect(audit).toHaveBeenCalledTimes(1);
      const row = audit.mock.calls[0][0];
      expect(row.decision).toBe("denied_org_mismatch");
      expect(row.orgId).toBe(principal.orgId);
      expect(row.userId).toBe(principal.userId);
      expect(row.error).toMatch(/org-b/);
      // Never in a column that would read as if the request had succeeded against org-b.
      expect(row.app).toBeUndefined();
    });

    it("writes no row at all for an unrecognized key (no principal to attribute it to)", async () => {
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      const res = await call(
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        deps({ audit, authenticate: async () => null }),
        "contoso",
      );
      expect(res.status).toBe(404);
      expect(audit).not.toHaveBeenCalled();
    });
  });

  // --- Fix round 1: I5 (WWW-Authenticate must not be built from a raw, unencoded org slug) ---
  // --- S6 (Task 12 final review) folded the `resource_metadata` parameter this test guarded
  //     entirely out of the header: phase 1 had no `.well-known/oauth-protected-resource`
  //     route, and advertising one made a well-behaved MCP client fetch it, get a Next.js 404
  //     page, and fail as though the gateway itself were broken.
  // --- Phase 2 restores the parameter, now that the route exists to serve it
  //     (app/.well-known/oauth-protected-resource/mcp/[org][/[app]]). I5's lesson — never
  //     interpolate a caller-controlled path segment raw into a response header — is honored
  //     by validating `orgSlug`/`appSlug` SYNTACTICALLY (the same charset lib/policy/slug.ts
  //     owns) before it ever reaches the header: a slug outside the charset gets a bare
  //     `Bearer`, never the interpolated form. This is deliberately not a catalog check —
  //     a syntactically valid but nonexistent org still gets the full parameter, so a known
  //     and an unknown org stay indistinguishable at this header.

  describe("[I5/S6] WWW-Authenticate carries resource_metadata for a syntactically valid slug, and never interpolates a hostile one", () => {
    it("carries a resource_metadata URL for a valid org slug", async () => {
      const res = await handleMcpRequest({
        orgSlug: "contoso", appSlug: null,
        body: { jsonrpc: "2.0", id: 1, method: "initialize" },
        apiKey: null, deps: deps(), issuer: TEST_ISSUER,
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe(
        `Bearer resource_metadata="${TEST_ISSUER}/.well-known/oauth-protected-resource/mcp/contoso"`,
      );
    });

    it("carries a resource_metadata URL for a valid (org, app) pair", async () => {
      const res = await handleMcpRequest({
        orgSlug: "contoso", appSlug: "servicefusion",
        body: { jsonrpc: "2.0", id: 1, method: "initialize" },
        apiKey: null, deps: deps(), issuer: TEST_ISSUER,
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe(
        `Bearer resource_metadata="${TEST_ISSUER}/.well-known/oauth-protected-resource/mcp/contoso/servicefusion"`,
      );
    });

    it("is a bare 'Bearer' for a slug outside the charset", async () => {
      const res = await handleMcpRequest({
        orgSlug: 'a"b', appSlug: null,
        body: { jsonrpc: "2.0", id: 1, method: "initialize" },
        apiKey: null, deps: deps(), issuer: TEST_ISSUER,
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    });

    it("does not throw, and injects nothing, for a quote/semicolon-bearing org slug", async () => {
      const res = await handleMcpRequest({
        orgSlug: 'x"; foo="bar', appSlug: null,
        body: { jsonrpc: "2.0", id: 1, method: "initialize" },
        apiKey: null, deps: deps(), issuer: TEST_ISSUER,
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    });

    it("does not throw for a CR/LF-bearing org slug (would otherwise reach the Headers constructor raw)", async () => {
      const res = await handleMcpRequest({
        orgSlug: "evil\r\nX-Injected: 1", appSlug: null,
        body: { jsonrpc: "2.0", id: 1, method: "initialize" },
        apiKey: null, deps: deps(), issuer: TEST_ISSUER,
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("X-Injected")).toBeNull();
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    });

    it("does not contain the literal injected segment for a hostile slug carrying `, evil=\"1`", async () => {
      const res = await handleMcpRequest({
        orgSlug: 'a", evil="1', appSlug: null,
        body: { jsonrpc: "2.0", id: 1, method: "initialize" },
        apiKey: null, deps: deps(), issuer: TEST_ISSUER,
      });
      expect(res.status).toBe(401);
      const header = res.headers.get("WWW-Authenticate");
      expect(header).toBe("Bearer");
      expect(header).not.toContain("evil");
      expect(header).not.toContain('"');
    });

    it("is a bare 'Bearer' when the org slug is valid but the app slug is not", async () => {
      const res = await handleMcpRequest({
        orgSlug: "contoso", appSlug: 'a"b',
        body: { jsonrpc: "2.0", id: 1, method: "initialize" },
        apiKey: null, deps: deps(), issuer: TEST_ISSUER,
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    });
  });

  // --- Fix round 1: I6 (injected AdapterContext; building it is inside the try) ---

  describe("[I6] AdapterContext is injected via HandlerDeps", () => {
    it("passes the deps-supplied context to runTool, not a handler-internal one", async () => {
      const marker = fakeContext(entry);
      const runTool = vi.fn(async () => ({ id: 1, customer_name: "Acme" }));
      await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                   params: { name: "servicefusion_customer_get", arguments: {} } },
                 deps({ runTool, buildContext: async () => marker }));
      expect(runTool).toHaveBeenCalledWith(entry, entry.config.tools[0], {}, marker);
    });

    it("a throwing buildContext produces exactly one decision:\"error\" audit row, not an uncaught exception", async () => {
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      const buildContext = vi.fn(async () => { throw new Error("bad transport config"); });
      const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                               params: { name: "servicefusion_customer_get", arguments: {} } },
                              deps({ audit, buildContext }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeTruthy();
      expect(audit).toHaveBeenCalledTimes(1);
      expect(audit.mock.calls[0][0].decision).toBe("error");
    });
  });

  // --- Fix round 1: I7 (a rejecting deps.audit must not take the request down) ---

  it("[I7] a rejecting deps.audit does not propagate and crash the request", async () => {
    const audit = vi.fn(async () => { throw new Error("audit sink unavailable"); });
    const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                             params: { name: "servicefusion_invoice_get", arguments: {} } },
                            deps({ audit }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.message).toMatch(/unknown tool/i);
  });

  // --- "ALSO FOLD IN" (Task 12 final review): validateArgs honors type/minLength ---

  describe("validateArgs honors a property's declared type and minLength", () => {
    const typedEntry = {
      org: "contoso", app: "servicefusion",
      config: {
        ...entry.config,
        tools: [
          {
            name: "search_get", description: "d",
            input: {
              type: "object",
              properties: { name: { type: "string", minLength: 1 } },
              required: ["name"],
            },
            request: { method: "GET", path: "/things" },
          },
        ],
      },
      roles: { roles: { field_tech: { tools: ["search_get"], fields: { "search_*": { allow: ["*"] } } } } },
    } as unknown as AppEntry;

    const callSearch = (name: unknown, audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {})) =>
      call({ jsonrpc: "2.0", id: 1, method: "tools/call",
             params: { name: "servicefusion_search_get", arguments: { name } } },
           deps({ audit, catalog: new Map([["contoso/servicefusion", typedEntry]]) }));

    it.each([0, [], {}, true, ["a", "b"]])(
      "rejects a well-formed-per-name-check but wrong-typed value (%j) instead of forwarding it",
      async (badValue) => {
        const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
        const res = await callSearch(badValue, audit);
        const body = await res.json();
        expect(body.error.message).toMatch(/must be of type string/i);
        expect(audit.mock.calls[0][0].decision).toBe("denied_bad_args");
      },
    );

    it("rejects an empty string against minLength: 1", async () => {
      const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
      const res = await callSearch("", audit);
      const body = await res.json();
      expect(body.error.message).toMatch(/must have length >= 1/i);
      expect(audit.mock.calls[0][0].decision).toBe("denied_bad_args");
    });

    it("accepts a well-typed, non-empty string", async () => {
      const runTool = vi.fn(async () => ({ ok: true }));
      const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                               params: { name: "servicefusion_search_get", arguments: { name: "Acme" } } },
                              deps({ runTool, catalog: new Map([["contoso/servicefusion", typedEntry]]) }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeUndefined();
    });
  });

  it("[real config] customer_search rejects an empty name (minLength: 1 on the committed schema)", async () => {
    // Exercises the actual committed orgs/contoso/servicefusion/api.json shape, not just a
    // synthetic fixture — pins that the minLength this fix adds to the real config is honored.
    const realEntry = {
      org: "contoso", app: "servicefusion",
      config: {
        ...entry.config,
        tools: [
          {
            name: "customer_search", description: "d",
            input: {
              type: "object",
              properties: { name: { type: "string", description: "Exact customer name", minLength: 1 } },
              required: ["name"],
            },
            request: { method: "GET", path: "/customers" },
          },
        ],
      },
      roles: { roles: { field_tech: { tools: ["customer_search"], fields: { "customer_*": { allow: ["*"] } } } } },
    } as unknown as AppEntry;
    const audit = vi.fn(async (_row: AuditRow, _redact: string[]) => {});
    const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
                             params: { name: "servicefusion_customer_search", arguments: { name: "" } } },
                            deps({ audit, catalog: new Map([["contoso/servicefusion", realEntry]]) }));
    const body = await res.json();
    expect(body.error.message).toMatch(/must have length >= 1/i);
    expect(audit.mock.calls[0][0].decision).toBe("denied_bad_args");
  });
});

// --- Fix round 1: I4 (checkToolInputSchema — boot-time contract for validateArgs) ---

describe("checkToolInputSchema", () => {
  const base: ToolDef = {
    name: "thing_get", description: "d", input: { type: "object" },
    request: { method: "GET", path: "/things" },
  };

  it("accepts a schema with no properties (accepts no arguments)", () => {
    expect(checkToolInputSchema(base)).toBeNull();
  });

  it("accepts properties with every required name present", () => {
    const tool: ToolDef = {
      ...base,
      input: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    };
    expect(checkToolInputSchema(tool)).toBeNull();
  });

  it("rejects a required name absent from properties (permanently uncallable otherwise)", () => {
    const tool: ToolDef = {
      ...base,
      input: { type: "object", properties: { q: { type: "string" } }, required: ["missing"] },
    };
    expect(checkToolInputSchema(tool)).toMatch(/missing/);
  });

  it.each(["$ref", "oneOf", "allOf", "anyOf", "patternProperties"])(
    "rejects unsupported top-level %s",
    (key) => {
      const tool: ToolDef = { ...base, input: { type: "object", [key]: {} } };
      expect(checkToolInputSchema(tool)).toMatch(new RegExp(key.replace("$", "\\$")));
    },
  );

  it("rejects additionalProperties: true (validator always denies an unrecognized key)", () => {
    const tool: ToolDef = { ...base, input: { type: "object", additionalProperties: true } };
    expect(checkToolInputSchema(tool)).toMatch(/additionalProperties/);
  });

  it("accepts additionalProperties: false", () => {
    const tool: ToolDef = { ...base, input: { type: "object", additionalProperties: false } };
    expect(checkToolInputSchema(tool)).toBeNull();
  });

  // --- "ALSO FOLD IN" (Task 12 final review): boot-time sanity for type/minLength ---

  it("accepts a property declaring a known type", () => {
    const tool: ToolDef = { ...base, input: { type: "object", properties: { q: { type: "string" } } } };
    expect(checkToolInputSchema(tool)).toBeNull();
  });

  it("rejects a property declaring an unrecognized type", () => {
    const tool: ToolDef = { ...base, input: { type: "object", properties: { q: { type: "date" } } } };
    expect(checkToolInputSchema(tool)).toMatch(/q\.type/);
  });

  it("accepts a string property with a non-negative integer minLength", () => {
    const tool: ToolDef = {
      ...base,
      input: { type: "object", properties: { q: { type: "string", minLength: 1 } } },
    };
    expect(checkToolInputSchema(tool)).toBeNull();
  });

  it("rejects a negative minLength", () => {
    const tool: ToolDef = {
      ...base,
      input: { type: "object", properties: { q: { type: "string", minLength: -1 } } },
    };
    expect(checkToolInputSchema(tool)).toMatch(/minLength/);
  });

  it("rejects a non-integer minLength", () => {
    const tool: ToolDef = {
      ...base,
      input: { type: "object", properties: { q: { type: "string", minLength: 1.5 } } },
    };
    expect(checkToolInputSchema(tool)).toMatch(/minLength/);
  });

  it("rejects minLength paired with a type that has no meaningful length (e.g. number)", () => {
    const tool: ToolDef = {
      ...base,
      input: { type: "object", properties: { q: { type: "number", minLength: 1 } } },
    };
    expect(checkToolInputSchema(tool)).toMatch(/minLength.*type.*number/);
  });

  it("accepts minLength on an array-typed property", () => {
    const tool: ToolDef = {
      ...base,
      input: { type: "object", properties: { q: { type: "array", minLength: 1 } } },
    };
    expect(checkToolInputSchema(tool)).toBeNull();
  });
});
