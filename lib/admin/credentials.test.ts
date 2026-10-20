import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppEntry } from "@/lib/types";

// `vi.hoisted` is required because `vi.mock` factories are hoisted above
// imports, so the mocks below can't close over an ordinary module-scope
// `const` declared after them — same reasoning as `lib/admin/invite.test.ts`
// and `lib/secrets/vault.test.ts`.
const { rpcMock, fromMock, getCatalogMock, fetchMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
  getCatalogMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock, from: fromMock }),
}));

vi.mock("@/lib/mcp/catalog", () => ({
  getCatalog: getCatalogMock,
}));

import { credentialFieldsFor, writeCredential, testConnection } from "@/lib/admin/credentials";

// Mirrors the real committed configs: orgs/contoso/servicefusion/api.json
// declares client_id/client_secret; orgs/globex/fieldedge/api.json
// declares those plus target_id. Nothing about credentialFieldsFor is
// hardcoded per provider — it only ever reads `entry.config.auth.secrets`.
function appEntry(org: string, app: string, secrets: Record<string, string>): AppEntry {
  return {
    org,
    app,
    config: {
      app,
      displayName: app,
      baseUrl: "https://example.test",
      auth: {
        type: "oauth2_client_credentials",
        tokenUrl: "https://example.test/oauth/token",
        bodyFormat: "json",
        secrets,
        expiry: { field: "expires_in", coerce: "number", skewSeconds: 60 },
      },
      transport: {
        minIntervalMs: 0,
        timeoutMs: 5000,
        retry: { attempts: 1, on: [], respectRetryAfter: false },
        errors: { format: "json" },
      },
      tools: [],
    } as unknown as AppEntry["config"],
    roles: { roles: {} },
  };
}

const CONTOSO_ENTRY = appEntry("contoso", "servicefusion", {
  client_id: "contoso/servicefusion/client_id",
  client_secret: "contoso/servicefusion/client_secret",
});

const GLOBEX_ENTRY = appEntry("globex", "fieldedge", {
  client_id: "globex/fieldedge/client_id",
  client_secret: "globex/fieldedge/client_secret",
  target_id: "globex/fieldedge/target_id",
});

const CATALOG = new Map<string, AppEntry>([
  ["contoso/servicefusion", CONTOSO_ENTRY],
  ["globex/fieldedge", GLOBEX_ENTRY],
]);

/** Chainable stand-in for the `admin_audit_events` select the way
 * credentialFieldsFor calls it: .select().eq().eq().eq().order().limit(). */
function auditChain(rows: Array<{ ts: string }>) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: async () => ({ data: rows, error: null }),
  };
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  getCatalogMock.mockReturnValue(CATALOG);

  // Default: no secret set, no audit history — overridden per test.
  rpcMock.mockResolvedValue({ data: null, error: null });
  fromMock.mockImplementation((table: string) => {
    if (table === "admin_audit_events") return auditChain([]);
    throw new Error(`unexpected table ${table}`);
  });
});

describe("credentialFieldsFor", () => {
  it("derives one field per auth.secrets entry, from committed config", async () => {
    // FieldEdge declares three; Service Fusion two. Nothing is hardcoded per provider.
    const f = await credentialFieldsFor("globex");
    expect(f.map((x) => x.key)).toEqual(["client_id", "client_secret", "target_id"]);
    expect(f[0].vaultName).toBe("globex/fieldedge/client_id");
  });

  it("reports whether a secret is set without ever returning its value", async () => {
    rpcMock.mockImplementation(async (fn: string, args: { p_name?: string }) => {
      if (fn === "read_vault_secret" && args.p_name === "contoso/servicefusion/client_id") {
        return { data: "s3cret", error: null };
      }
      return { data: null, error: null };
    });

    const f = await credentialFieldsFor("contoso");
    expect(f[0].isSet).toBe(true);
    expect(JSON.stringify(f)).not.toMatch(/s3cret/);
    expect(Object.keys(f[0])).toEqual(["app", "key", "vaultName", "isSet", "updatedAt"]);
  });
});

describe("writeCredential", () => {
  it("refuses to write a vault name outside the org's own prefix", async () => {
    await expect(
      writeCredential("globex/fieldedge/client_secret", "x", { orgSlug: "contoso" }),
    ).rejects.toThrow(/does not belong/);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  // Additional case beyond the plan's own cross-org test above: the prefix
  // check must require the separating slash, not just a shared character
  // run — otherwise an org slug that is a prefix of another org's slug
  // (e.g. "contoso" vs. a hypothetical "contoso-2") could cross the
  // boundary via string-prefix coincidence alone.
  it("rejects a vault name whose org segment merely shares characters with ctx.orgSlug (no slash boundary)", async () => {
    await expect(
      writeCredential("contoso-2/servicefusion/client_secret", "x", { orgSlug: "contoso" }),
    ).rejects.toThrow(/does not belong/);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("testConnection", () => {
  it("never includes the upstream response body in a failed connection test", async () => {
    // Resolve client_id/client_secret through the vault RPC so the
    // client-credentials request actually reaches `fetch`.
    rpcMock.mockImplementation(async (fn: string, args: { p_name?: string }) => {
      if (fn === "read_vault_secret") return { data: "value-for-" + args.p_name, error: null };
      return { data: null, error: null };
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "leak-me" }), { status: 401 }),
    );

    const r = await testConnection("contoso", "servicefusion");
    expect(JSON.stringify(r)).not.toMatch(/leak-me/);
    expect(r).toEqual({ ok: false, detail: "HTTP 401" });
  });

  it("refuses a vault name no app in the org declares, even with the right prefix", async () => {
    // `vaultName` arrives as a hidden form field, so it is caller-controlled.
    await expect(
      writeCredential("contoso/servicefusion/made_up", "x", { orgSlug: "contoso" }),
    ).rejects.toThrow(/not declared by any app/);
  });

  it("accepts a vault name the committed config does declare", async () => {
    await expect(
      writeCredential("contoso/servicefusion/client_secret", "x", { orgSlug: "contoso" }),
    ).resolves.toBeUndefined();
  });
});
