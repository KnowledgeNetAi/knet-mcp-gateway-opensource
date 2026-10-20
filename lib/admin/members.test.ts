import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppEntry } from "@/lib/types";

// `vi.hoisted` is required because `vi.mock` factories are hoisted above
// imports, so the mocks below can't close over an ordinary module-scope
// `const` declared after them — same reasoning as `lib/admin/invite.test.ts`.
const { fromMock, rpcMock, listUsersMock, getCatalogMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  listUsersMock: vi.fn(),
  getCatalogMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: fromMock,
    rpc: rpcMock,
    auth: { admin: { listUsers: listUsersMock } },
  }),
}));

// `lib/admin/members.ts` imports the REAL `validRolesForOrg` from
// `lib/admin/invite.ts` (Global Constraints: use it, don't write a second
// reader of roles.json). Mocking the catalog it reads through — the same
// seam `lib/admin/invite.test.ts` mocks — exercises the real validation
// logic instead of a stand-in.
vi.mock("@/lib/mcp/catalog", () => ({
  getCatalog: getCatalogMock,
}));

import { listMembers, setAdminRole, setDataRoles, removeMember } from "@/lib/admin/members";

// Mirrors orgs/contoso/servicefusion/roles.json's real role names, same
// fixture as lib/admin/invite.test.ts.
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

type Row = Record<string, unknown>;

// Captures routed BY TABLE NAME (and operation), not by payload shape — same
// discipline lib/admin/invite.test.ts's upsertMock follows, for the same
// reason: a select and a write on the same table must never be confused
// with one another just because a payload happens to look a certain way.
let callOrder: string[];
let deletedRoles: string[];
let insertedRoles: string[];
let membershipRows: Array<{ user_id: string; admin_role: "org_admin" | "member"; invited_at: string | null }>;
let existingRoleRows: Array<{ role: string }>;
let authUsers: Array<{ id: string; email?: string; last_sign_in_at?: string; email_confirmed_at?: string }>;

function seedMembers(
  entries: Array<{ userId: string; adminRole: "org_admin" | "member"; invitedAt?: string | null }>,
) {
  membershipRows = entries.map((e) => ({
    user_id: e.userId,
    admin_role: e.adminRole,
    invited_at: e.invitedAt ?? null,
  }));
}

function seedRoles(roles: string[]) {
  existingRoleRows = roles.map((role) => ({ role }));
}

/**
 * A minimal stand-in for the subset of the supabase-js query-builder chain
 * `lib/admin/members.ts` actually uses: `.select(...).eq(...).eq(...)`,
 * `.update(...).eq(...).eq(...).is(...)`, `.delete().eq(...).eq(...)`, and
 * `.insert(...)`, each awaited directly (no `.single()`/`.maybeSingle()`),
 * exactly like the real client whose query builder is itself a thenable.
 *
 * Resolution is keyed on (table, op, filters) rather than a shared in-memory
 * database, because each function under test drives a different table
 * through a different chain shape; a single generic fake DB would obscure
 * which call is being asserted on more than it would help.
 */
function makeBuilder(table: string) {
  const filters: Row = {};
  let op: "select" | "update" | "delete" | "insert" = "select";
  let payload: Row | undefined;

  const builder = {
    select(_cols?: string) {
      op = "select";
      return builder;
    },
    update(p: Row) {
      op = "update";
      payload = p;
      callOrder.push(`${table}.update`);
      return builder;
    },
    delete() {
      op = "delete";
      callOrder.push(`${table}.delete`);
      return builder;
    },
    insert(p: Row) {
      op = "insert";
      payload = p;
      callOrder.push(`${table}.insert`);
      return builder;
    },
    eq(col: string, val: unknown) {
      filters[col] = val;
      return builder;
    },
    is(col: string, val: null) {
      filters[col] = val;
      return builder;
    },
    then<T1, T2>(
      onFulfilled?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
      onRejected?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
    ) {
      return Promise.resolve(resolve()).then(onFulfilled, onRejected);
    },
  };

  function resolve(): { data: unknown; error: unknown } {
    if (table === "memberships") {
      if (op === "select") {
        if ("admin_role" in filters) {
          return {
            data: membershipRows
              .filter((r) => r.admin_role === filters.admin_role)
              .map((r) => ({ user_id: r.user_id })),
            error: null,
          };
        }
        return {
          data: membershipRows.map((r) => ({
            user_id: r.user_id,
            admin_role: r.admin_role,
            invited_at: r.invited_at,
          })),
          error: null,
        };
      }
      if (op === "update") {
        const row = membershipRows.find((r) => r.user_id === filters.user_id);
        if (row) Object.assign(row, payload);
        return { data: null, error: null };
      }
      if (op === "delete") {
        membershipRows = membershipRows.filter((r) => r.user_id !== filters.user_id);
        return { data: null, error: null };
      }
    }

    if (table === "role_assignments") {
      if (op === "select") {
        return { data: existingRoleRows.map((r) => ({ ...r })), error: null };
      }
      if (op === "delete") {
        deletedRoles.push(filters.role as string);
        return { data: null, error: null };
      }
      if (op === "insert") {
        insertedRoles.push((payload as Row).role as string);
        return { data: null, error: null };
      }
    }

    throw new Error(`unexpected call: ${table}.${op}`);
  }

  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  getCatalogMock.mockReturnValue(CATALOG);

  callOrder = [];
  deletedRoles = [];
  insertedRoles = [];
  existingRoleRows = [];

  // Default fixture: two members, neither of whom is the sole org_admin, and
  // neither has signed in yet — chosen so that tests exercising removal/role
  // changes on "u2" don't trip the last-admin rule unless they explicitly
  // seed a single-admin org via `seedMembers`.
  seedMembers([
    { userId: "u1", adminRole: "org_admin" },
    { userId: "u2", adminRole: "member", invitedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  authUsers = [{ id: "u1", email: "u1@example.com" }, { id: "u2", email: "u2@example.com" }];

  fromMock.mockImplementation((table: string) => makeBuilder(table));
  rpcMock.mockImplementation(async (name: string, args: Record<string, string>) => {
    callOrder.push(`rpc.${name}`);
    const target = membershipRows.find((r) => r.user_id === args.p_user_id);
    if (!target) return { data: "not_a_member", error: null };
    const adminCount = membershipRows.filter((r) => r.admin_role === "org_admin").length;

    if (name === "set_membership_admin_role") {
      if (target.admin_role === "org_admin" && args.p_admin_role === "member" && adminCount <= 1) {
        return { data: "last_admin", error: null };
      }
      target.admin_role = args.p_admin_role as "org_admin" | "member";
      return { data: "ok", error: null };
    }

    if (name === "remove_org_member") {
      if (target.admin_role === "org_admin" && adminCount <= 1) {
        return { data: "last_admin", error: null };
      }
      membershipRows = membershipRows.filter((r) => r.user_id !== args.p_user_id);
      return { data: "ok", error: null };
    }

    return { data: null, error: { message: `unexpected RPC ${name}` } };
  });
  listUsersMock.mockImplementation(async () => ({ data: { users: authUsers }, error: null }));
});

describe("removeMember", () => {
  // Spec decision 7 — the sharpest edge in the feature.
  it("uses the atomic database mutation for key revocation and row deletion", async () => {
    await removeMember("o1", "u2");
    expect(callOrder).toEqual(["rpc.remove_org_member"]);
  });

  it("passes both org and user ids to the atomic removal function", async () => {
    await removeMember("o1", "u2");
    expect(rpcMock).toHaveBeenCalledWith("remove_org_member", {
      p_org_id: "o1",
      p_user_id: "u2",
    });
  });

  it("refuses to remove the last org_admin", async () => {
    seedMembers([{ userId: "u2", adminRole: "org_admin" }]);
    await expect(removeMember("o1", "u2")).rejects.toMatchObject({ reason: "last_admin" });
    // The atomic function was called, but returned before writing anything.
    expect(callOrder).toEqual(["rpc.remove_org_member"]);
  });

  it("allows removing an org_admin when another remains", async () => {
    seedMembers([
      { userId: "u2", adminRole: "org_admin" },
      { userId: "u3", adminRole: "org_admin" },
    ]);
    await expect(removeMember("o1", "u2")).resolves.toBeUndefined();
  });

  it("reports a nonexistent target instead of auditing a no-op as success", async () => {
    await expect(removeMember("o1", "missing")).rejects.toMatchObject({ reason: "not_a_member" });
  });
});

describe("setAdminRole", () => {
  it("refuses to demote the last org_admin", async () => {
    seedMembers([{ userId: "u2", adminRole: "org_admin" }]);
    await expect(setAdminRole("o1", "u2", "member")).rejects.toMatchObject({ reason: "last_admin" });
  });

  it("uses the atomic database mutation with the requested role", async () => {
    await setAdminRole("o1", "u2", "org_admin");
    expect(rpcMock).toHaveBeenCalledWith("set_membership_admin_role", {
      p_org_id: "o1",
      p_user_id: "u2",
      p_admin_role: "org_admin",
    });
  });

  it("reports a nonexistent target instead of auditing a no-op as success", async () => {
    await expect(setAdminRole("o1", "missing", "member")).rejects.toMatchObject({
      reason: "not_a_member",
    });
  });
});

describe("setDataRoles", () => {
  it("validates data roles against roles.json before writing", async () => {
    await expect(setDataRoles("o1", "contoso", "u2", ["nope"])).rejects.toMatchObject({
      reason: "unknown_role",
    });
    expect(deletedRoles).toEqual([]);
    expect(insertedRoles).toEqual([]);
  });

  it("replaces the role set: deletes what is gone, inserts what is new", async () => {
    seedRoles(["owner", "bookkeeper"]);
    await setDataRoles("o1", "contoso", "u2", ["owner", "field_tech"]);
    expect(deletedRoles).toEqual(["bookkeeper"]);
    expect(insertedRoles).toEqual(["field_tech"]);
  });
});

describe("listMembers", () => {
  it("marks an unconfirmed invitation as pending", async () => {
    const [m] = await listMembers("o1");
    expect(m.pending).toBe(true);
  });

  it("marks a confirmed invitation accepted even before the first sign-in", async () => {
    authUsers[0].email_confirmed_at = "2026-01-02T00:00:00.000Z";
    const [m] = await listMembers("o1");
    expect(m).toMatchObject({
      pending: false,
      acceptedAt: "2026-01-02T00:00:00.000Z",
      lastSignInAt: null,
    });
  });
});
