import { describe, it, expect, vi } from "vitest";
import { handleMcpRequest, type HandlerDeps } from "@/lib/mcp/handler";
import type { AppEntry, Principal } from "@/lib/types";
import type { AdapterContext } from "@/lib/adapters/types";
import type { AuditRow } from "@/lib/audit/log";

/**
 * End-to-end write policy through the real handler: the seam where a tool's
 * `write.fieldsFrom` (api.json), a role's `writes` allowlist (roles.json) and
 * `writableFieldProblems` (lib/policy/write-policy.ts) have to agree. Each of
 * those is unit-tested on its own; nothing but this file proves a request
 * actually traverses all three.
 */

function fakeContext(entry: AppEntry): AdapterContext {
  return {
    http: { request: async () => ({ status: 200, data: null, raw: "" }) },
    secret: async () => "unused",
    config: entry.config,
    log: () => {},
  };
}

const entry = {
  org: "umbrella",
  app: "hubspot",
  config: {
    app: "hubspot",
    displayName: "HubSpot",
    baseUrl: "https://api.hubapi.test",
    auth: {
      type: "oauth2_refresh_token",
      tokenUrl: "https://api.hubapi.test/oauth/v1/token",
      bodyFormat: "form",
      secrets: { client_id: "a", client_secret: "b", refresh_token: "c" },
      expiry: { field: "expires_in", coerce: "number", skewSeconds: 60 },
    },
    transport: {
      minIntervalMs: 0,
      timeoutMs: 5000,
      retry: { attempts: 1, on: [], respectRetryAfter: false },
      errors: { format: "json" },
    },
    tools: [
      {
        name: "contact_update",
        description: "Update a contact",
        input: {
          type: "object",
          properties: {
            contactId: { type: "string", minLength: 1 },
            fields: { type: "object" },
          },
          required: ["contactId", "fields"],
        },
        request: {
          method: "PATCH",
          path: "/crm/v3/objects/contacts/{{contactId}}",
          body: { properties: "{{fields}}" },
        },
        write: { fieldsFrom: "fields" },
      },
      {
        name: "contact_get",
        description: "Get a contact",
        input: { type: "object", properties: {} },
        request: { method: "GET", path: "/crm/v3/objects/contacts" },
      },
    ],
  },
  roles: {
    roles: {
      // Grants the write tool, and may write exactly two fields.
      editor: {
        tools: ["contact_update", "contact_get"],
        fields: { "*": { allow: ["id"] } },
        writes: { contact_update: { allow: ["firstname", "lastname"] } },
      },
      // Grants the same tool with NO writes rule. lib/config/load.ts rejects
      // this shape at boot; the handler must still deny at runtime rather than
      // relying on that check having run.
      viewer: {
        tools: ["contact_update"],
        fields: { "*": { allow: ["id"] } },
      },
    },
  },
} as unknown as AppEntry;

function principal(roles: string[]): Principal {
  return { userId: "u1", orgId: "o1", orgSlug: "umbrella", roles, oauthResource: null };
}

function deps(roles: string[], over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    catalog: new Map([["umbrella/hubspot", entry]]),
    authenticate: async () => principal(roles),
    runTool: async () => ({ id: "151", properties: { firstname: "Ada" } }),
    audit: async () => {},
    buildContext: async (e: AppEntry) => fakeContext(e),
    ...over,
  };
}

const callTool = (args: unknown, d: HandlerDeps) =>
  handleMcpRequest({
    orgSlug: "umbrella",
    appSlug: "hubspot",
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hubspot_contact_update", arguments: args } },
    apiKey: "kngw_x",
    deps: d,
    issuer: "https://gw.example.com",
  });

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("write policy at the handler", () => {
  it("dispatches a write whose every field is in the role's allowlist", async () => {
    const runTool = vi.fn(async () => ({ id: "151" }));
    const res = await callTool(
      { contactId: "151", fields: { firstname: "Ada", lastname: "Lovelace" } },
      deps(["editor"], { runTool }),
    );
    expect(runTool).toHaveBeenCalledOnce();
    expect(await bodyOf(res)).not.toHaveProperty("error");
  });

  it("refuses the whole call when one field is outside the allowlist, and never dispatches", async () => {
    // Not "filter it out and continue": a caller asking to write a field they
    // may not write is making a request nobody can partially honor without
    // silently writing something other than what was asked for.
    const runTool = vi.fn(async () => ({ id: "151" }));
    const res = await callTool(
      { contactId: "151", fields: { firstname: "Ada", lifecyclestage: "customer" } },
      deps(["editor"], { runTool }),
    );
    expect(runTool).not.toHaveBeenCalled();
    const body = await bodyOf(res);
    expect(JSON.stringify(body)).toContain("lifecyclestage");
  });

  it("denies every field for a role that grants the tool but declares no writes rule", async () => {
    const runTool = vi.fn(async () => ({ id: "151" }));
    await callTool({ contactId: "151", fields: { firstname: "Ada" } }, deps(["viewer"], { runTool }));
    expect(runTool).not.toHaveBeenCalled();
  });

  it("unions write allowlists across roles, like every other grant", async () => {
    const runTool = vi.fn(async () => ({ id: "151" }));
    await callTool(
      { contactId: "151", fields: { firstname: "Ada" } },
      deps(["viewer", "editor"], { runTool }),
    );
    // `viewer` grants the tool and nothing writable; `editor` grants both.
    // Additive, so holding the extra role must not remove access.
    expect(runTool).toHaveBeenCalledOnce();
  });

  it("audits a refused write as denied_bad_args, with the offending field named", async () => {
    const rows: AuditRow[] = [];
    await callTool(
      { contactId: "151", fields: { lifecyclestage: "customer" } },
      deps(["editor"], { audit: async (r: AuditRow) => void rows.push(r) }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("denied_bad_args");
    expect(rows[0].error).toContain("lifecyclestage");
  });

  it("refuses a write whose field bag is a scalar rather than an object", async () => {
    const runTool = vi.fn(async () => ({ id: "151" }));
    await callTool({ contactId: "151", fields: "firstname=Ada" }, deps(["editor"], { runTool }));
    expect(runTool).not.toHaveBeenCalled();
  });

  it("leaves read tools completely untouched by write policy", async () => {
    const runTool = vi.fn(async () => ({ id: "151" }));
    const res = await handleMcpRequest({
      orgSlug: "umbrella",
      appSlug: "hubspot",
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hubspot_contact_get", arguments: {} } },
      apiKey: "kngw_x",
      deps: deps(["editor"], { runTool }),
      issuer: "https://gw.example.com",
    });
    expect(runTool).toHaveBeenCalledOnce();
    expect(await bodyOf(res)).not.toHaveProperty("error");
  });
});
