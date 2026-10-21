import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppEntry } from "@/lib/types";

// `vi.hoisted` is required because `vi.mock` factories are hoisted above
// imports, so the mocks below can't close over an ordinary module-scope
// `const` declared after them — same reasoning as `lib/secrets/vault.test.ts`.
const {
  inviteUserByEmailMock,
  listUsersMock,
  upsertMock,
  fromMock,
  getCatalogMock,
  rpcMock,
} = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  inviteUserByEmailMock: vi.fn(),
  listUsersMock: vi.fn(),
  upsertMock: vi.fn(),
  fromMock: vi.fn(),
  getCatalogMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: fromMock,
    rpc: rpcMock,
    auth: { admin: { inviteUserByEmail: inviteUserByEmailMock, listUsers: listUsersMock } },
  }),
}));

vi.mock("@/lib/mcp/catalog", () => ({
  getCatalog: getCatalogMock,
}));

import { inviteMember } from "@/lib/admin/invite";

// Mirrors orgs/contoso/servicefusion/roles.json's real role names.
const CATALOG = new Map<string, AppEntry>([
  [
    "contoso/servicefusion",
    {
      org: "contoso",
      app: "servicefusion",
      config: {} as AppEntry["config"],
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

// Captures for the two tables invite writes to. Routed by TABLE NAME, not by
// payload shape: a membership upsert legitimately omits `admin_role` when the
// caller left the existing platform role untouched, so branching on that key's
// presence would misfile the row as a role_assignments write and silently pass
// a test that should fail.
let membershipUpsert: Record<string, unknown> | undefined;
let roleUpserts: Array<Record<string, unknown>>;
// The caller's existing membership in the org, if any.
let existingMembership: { admin_role: "org_admin" | "member" } | null;

beforeEach(() => {
  vi.clearAllMocks();
  getCatalogMock.mockReturnValue(CATALOG);
  membershipUpsert = undefined;
  roleUpserts = [];
  existingMembership = null;
  rpcMock.mockResolvedValue({ data: "ok", error: null });

  inviteUserByEmailMock.mockResolvedValue({ data: { user: { id: "u2" } }, error: null });
  upsertMock.mockImplementation(async (table: string, row: Record<string, unknown>) => {
    if (table === "memberships") membershipUpsert = row;
    else roleUpserts.push(row);
    return { error: null };
  });

  fromMock.mockImplementation((table: string) => {
    if (table === "organizations") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { id: "o1", slug: "contoso" }, error: null }),
          }),
        }),
      };
    }
    if (table === "memberships") {
      return {
        upsert: (row: Record<string, unknown>) => upsertMock(table, row),
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: existingMembership, error: null }) }) }),
        }),
      };
    }
    if (table === "role_assignments") {
      return { upsert: (row: Record<string, unknown>) => upsertMock(table, row) };
    }
    throw new Error(`unexpected table ${table}`);
  });
});

const args = {
  orgSlug: "contoso",
  email: "a@b.co",
  adminRole: "member" as const,
  dataRoles: ["owner"],
  invitedBy: "u9",
};

describe("inviteMember", () => {
  it("rejects a role no app in the org defines, before writing anything", async () => {
    await expect(
      inviteMember({
        orgSlug: "contoso",
        email: "a@b.co",
        adminRole: "member",
        dataRoles: ["nonexistent"],
        invitedBy: "u1",
      }),
    ).rejects.toMatchObject({ reason: "unknown_role" });
    expect(inviteUserByEmailMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("names the valid roles in the error so the admin can fix it", async () => {
    await expect(inviteMember({ ...args, dataRoles: ["nope"] })).rejects.toThrow(/bookkeeper/);
  });

  it("writes admin_role, invited_by and invited_at onto the membership", async () => {
    await inviteMember({
      orgSlug: "contoso",
      email: "a@b.co",
      adminRole: "org_admin",
      dataRoles: ["owner"],
      invitedBy: "u9",
    });
    expect(membershipUpsert).toMatchObject({ admin_role: "org_admin", invited_by: "u9" });
    expect(membershipUpsert?.invited_at).toEqual(expect.any(String));
  });

  it("is idempotent for an email that already has an account", async () => {
    inviteUserByEmailMock.mockResolvedValue({
      data: null,
      error: { code: "email_exists", message: "already registered" },
    });
    listUsersMock.mockResolvedValue({ data: { users: [{ id: "u2", email: "a@b.co" }] }, error: null });
    const r = await inviteMember({ ...args });
    expect(r).toMatchObject({ userId: "u2", alreadyExisted: true });
  });

  it("writes one role_assignments row per data role", async () => {
    await inviteMember({ ...args, dataRoles: ["owner", "bookkeeper"] });
    expect(roleUpserts).toEqual([
      { user_id: "u2", org_id: "o1", role: "owner" },
      { user_id: "u2", org_id: "o1", role: "bookkeeper" },
    ]);
  });

  // Regression: scripts/invite.ts is documented as safe to re-run. It passes
  // no adminRole, and if that were sent as "member" the upsert would overwrite
  // an existing org_admin's row and silently strip their console access.
  it("leaves admin_role alone when the caller does not specify one", async () => {
    await inviteMember({
      orgSlug: "contoso",
      email: "a@b.co",
      dataRoles: ["owner"],
      invitedBy: null,
    });
    expect(membershipUpsert).toBeDefined();
    expect(membershipUpsert).not.toHaveProperty("admin_role");
    expect(membershipUpsert).toMatchObject({ user_id: "u2", org_id: "o1", invited_by: null });
  });

  it("writes admin_role only when the caller asks for one", async () => {
    await inviteMember({ ...args, adminRole: "org_admin" });
    expect(membershipUpsert).toMatchObject({ admin_role: "org_admin" });
  });

  it("never writes a platform role into role_assignments", async () => {
    await inviteMember({ ...args, adminRole: "org_admin", dataRoles: ["owner"] });
    expect(JSON.stringify(roleUpserts)).not.toMatch(/org_admin/);
  });

  it("re-inviting an existing member changes their admin role only through the last-admin check", async () => {
    existingMembership = { admin_role: "org_admin" };
    rpcMock.mockResolvedValue({ data: "last_admin", error: null });
    await expect(
      inviteMember({ orgSlug: "contoso", email: "a@b.co", adminRole: "member", dataRoles: [], invitedBy: null }),
    ).rejects.toMatchObject({ reason: "last_admin" });
    expect(rpcMock).toHaveBeenCalledWith("set_membership_admin_role", {
      p_org_id: "o1",
      p_user_id: "u2",
      p_admin_role: "member",
    });
    expect(membershipUpsert).toBeUndefined();
  });

  it("never writes admin_role directly onto an existing membership", async () => {
    existingMembership = { admin_role: "member" };
    await inviteMember({ orgSlug: "contoso", email: "a@b.co", adminRole: "org_admin", dataRoles: [], invitedBy: null });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(membershipUpsert).not.toHaveProperty("admin_role");
  });
});
