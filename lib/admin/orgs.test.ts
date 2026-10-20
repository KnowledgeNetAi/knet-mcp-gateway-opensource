import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppEntry } from "@/lib/types";

// `vi.hoisted` is required because `vi.mock` factories are hoisted above
// imports, so the mocks below can't close over an ordinary module-scope
// `const` declared after them — same reasoning as `lib/admin/invite.test.ts`.
const { insertMock, fromMock, getCatalogMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  fromMock: vi.fn(),
  getCatalogMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: fromMock }),
}));

vi.mock("@/lib/mcp/catalog", () => ({
  getCatalog: getCatalogMock,
}));

import { createOrg, orgOverview, OrgError } from "@/lib/admin/orgs";

// Mirrors orgs/contoso/servicefusion's real committed config: 3 tools,
// roles field_tech/bookkeeper/owner. "newco" deliberately has no entry —
// an org with no committed config legitimately has zero apps.
const CATALOG = new Map<string, AppEntry>([
  [
    "contoso/servicefusion",
    {
      org: "contoso",
      app: "servicefusion",
      config: {
        app: "servicefusion",
        displayName: "Service Fusion",
        tools: [{}, {}, {}],
      } as unknown as AppEntry["config"],
      roles: {
        roles: {
          field_tech: { tools: [], fields: {} },
          bookkeeper: { tools: [], fields: {} },
          owner: { tools: [], fields: {} },
        },
      },
    },
  ],
]);

const ORGS: Record<string, { id: string; slug: string; name: string }> = {
  contoso: { id: "id-contoso", slug: "contoso", name: "Contoso" },
  newco: { id: "id-newco", slug: "newco", name: "Newco" },
};

beforeEach(() => {
  vi.clearAllMocks();
  getCatalogMock.mockReturnValue(CATALOG);
  insertMock.mockResolvedValue({ data: { id: "o-new" }, error: null });

  fromMock.mockImplementation((table: string) => {
    if (table === "organizations") {
      return {
        select: () => ({
          eq: (_c: string, slug: string) => ({
            maybeSingle: async () => ({ data: ORGS[slug] ?? null, error: null }),
          }),
        }),
        insert: (row: Record<string, unknown>) => ({
          select: () => ({ single: () => insertMock(row) }),
        }),
      };
    }
    if (table === "memberships") {
      return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
    }
    if (table === "api_keys") {
      return {
        select: () => ({ eq: () => ({ is: async () => ({ data: [], error: null }) }) }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
});

describe("createOrg", () => {
  it("rejects a slug outside the api-key charset", async () => {
    // Must round-trip through parseKey or every key minted for this org is unauthenticatable.
    await expect(createOrg({ slug: "Acme Corp", name: "Acme" })).rejects.toMatchObject({
      reason: "bad_slug",
    });
    await expect(createOrg({ slug: "acme_corp", name: "Acme" })).rejects.toMatchObject({
      reason: "bad_slug",
    });
    await expect(createOrg({ slug: "acme-corp", name: "Acme" })).resolves.toMatchObject({
      id: expect.any(String),
    });
  });

  it("reports a duplicate slug as slug_taken, not a raw database error", async () => {
    insertMock.mockResolvedValue({ error: { code: "23505", message: "duplicate key" } });
    await expect(createOrg({ slug: "contoso", name: "x" })).rejects.toMatchObject({
      reason: "slug_taken",
    });
    await expect(createOrg({ slug: "contoso", name: "x" })).rejects.toBeInstanceOf(OrgError);
  });
});

describe("orgOverview", () => {
  it("lists an org's apps from the git catalog, not the database", async () => {
    const o = await orgOverview("contoso");
    expect(o.apps).toEqual([
      { app: "servicefusion", displayName: "Service Fusion", toolCount: 3, roles: ["bookkeeper", "field_tech", "owner"] },
    ]);
  });

  it("reports zero apps for an org with no committed config", async () => {
    const o = await orgOverview("newco");
    expect(o.apps).toEqual([]);
  });
});
