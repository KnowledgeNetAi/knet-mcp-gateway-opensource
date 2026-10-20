import { describe, it, expect, vi, beforeEach } from "vitest";

const { getUserMock, fromMock, redirectMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  fromMock: vi.fn(),
  redirectMock: vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: getUserMock } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: fromMock }),
}));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

import { getViewer, requireOrgAdmin, requireSuperAdmin } from "@/lib/authz/viewer";

/**
 * Stands in for the query builder. `platform_admins` returns rows only when
 * `isSuper`; `memberships` returns the given orgs joined to organizations;
 * `organizations` resolves any slug (the super-admin path).
 */
function seed({ isSuper = false, orgs = [] as Array<{ slug: string; adminRole: string }> } = {}) {
  fromMock.mockImplementation((table: string) => {
    if (table === "platform_admins") {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: isSuper ? { user_id: "u1" } : null, error: null }) }) }) };
    }
    if (table === "memberships") {
      return { select: () => ({ eq: async () => ({
        data: orgs.map((o) => ({ admin_role: o.adminRole, organizations: { id: `id-${o.slug}`, slug: o.slug, name: o.slug } })),
        error: null }) }) };
    }
    if (table === "organizations") {
      return { select: () => ({ eq: (_c: string, slug: string) => ({ maybeSingle: async () => ({ data: { id: `id-${slug}`, slug, name: slug }, error: null }) }) }) };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue({ data: { user: { id: "u1", email: "a@b.co" } } });
});

describe("getViewer", () => {
  it("returns null when nobody is signed in", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    seed();
    expect(await getViewer()).toBeNull();
  });

  it("reports super admin status and the viewer's orgs", async () => {
    seed({ isSuper: true, orgs: [{ slug: "contoso", adminRole: "member" }] });
    const v = await getViewer();
    expect(v?.isSuperAdmin).toBe(true);
    expect(v?.orgs).toEqual([{ id: "id-contoso", slug: "contoso", name: "contoso", adminRole: "member" }]);
  });
});

describe("requireOrgAdmin", () => {
  it("passes an org_admin for their own org", async () => {
    seed({ orgs: [{ slug: "contoso", adminRole: "org_admin" }] });
    const { org } = await requireOrgAdmin("contoso");
    expect(org.slug).toBe("contoso");
  });

  // The single most important assertion in this phase: super admin crosses orgs.
  it("passes a super admin for an org they are not a member of", async () => {
    seed({ isSuper: true, orgs: [] });
    const { viewer, org } = await requireOrgAdmin("globex");
    expect(viewer.isSuperAdmin).toBe(true);
    expect(org).toMatchObject({ slug: "globex", adminRole: "org_admin" });
  });

  it("redirects an org_admin of one org away from another org", async () => {
    seed({ orgs: [{ slug: "contoso", adminRole: "org_admin" }] });
    await expect(requireOrgAdmin("globex")).rejects.toThrow("REDIRECT:/admin?error=forbidden");
  });

  it("redirects a plain member of the very org they are asking about", async () => {
    seed({ orgs: [{ slug: "contoso", adminRole: "member" }] });
    await expect(requireOrgAdmin("contoso")).rejects.toThrow("REDIRECT:/admin?error=forbidden");
  });

  it("redirects to login when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    seed();
    await expect(requireOrgAdmin("contoso")).rejects.toThrow("REDIRECT:/login");
  });
});

describe("requireSuperAdmin", () => {
  it("redirects an org_admin", async () => {
    seed({ orgs: [{ slug: "contoso", adminRole: "org_admin" }] });
    await expect(requireSuperAdmin()).rejects.toThrow("REDIRECT:/admin?error=forbidden");
  });
});
