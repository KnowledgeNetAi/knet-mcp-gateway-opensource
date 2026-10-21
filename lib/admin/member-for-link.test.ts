import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    users: [] as Array<{ id: string; email: string }>,
    memberships: [] as Array<{ user_id: string; org_id: string }>,
    platformAdmins: [] as string[],
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: { admin: { listUsers: async () => ({ data: { users: state.users }, error: null }) } },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const rows = () =>
        table === "memberships"
          ? state.memberships.filter((m) => m.user_id === filters.user_id)
          : state.platformAdmins.filter((id) => id === filters.user_id).map((user_id) => ({ user_id }));
      const q = {
        select: () => q,
        eq(col: string, val: unknown) {
          filters[col] = val;
          return q;
        },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok: (v: { data: unknown; error: null }) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok),
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/mcp/catalog", () => ({ getCatalog: () => new Map() }));

import { memberForLink } from "@/lib/admin/members";

beforeEach(() => {
  state.users = [
    { id: "a1", email: "admin@a.example" },
    { id: "p1", email: "pending@a.example" },
    { id: "b1", email: "ceo@b.example" },
    { id: "x1", email: "both@a.example" },
  ];
  state.memberships = [
    { user_id: "a1", org_id: "A" },
    { user_id: "p1", org_id: "A" },
    { user_id: "b1", org_id: "B" },
    { user_id: "x1", org_id: "A" },
    { user_id: "x1", org_id: "B" },
  ];
  state.platformAdmins = [];
});

describe("memberForLink", () => {
  it("refuses an address that belongs to another org only", async () => {
    expect(await memberForLink("A", "ceo@b.example")).toBeNull();
  });

  it("refuses an address with no account at all", async () => {
    expect(await memberForLink("A", "nobody@example.com")).toBeNull();
  });

  it("accepts a member of this org, case-insensitively", async () => {
    expect(await memberForLink("A", " Pending@A.example ")).toEqual({ userId: "p1", beyondOrg: false });
  });

  it("flags a member whose account also reaches another org", async () => {
    expect(await memberForLink("A", "both@a.example")).toEqual({ userId: "x1", beyondOrg: true });
  });

  it("flags a member who is also a super admin", async () => {
    state.platformAdmins = ["p1"];
    expect(await memberForLink("A", "pending@a.example")).toEqual({ userId: "p1", beyondOrg: true });
  });
});
