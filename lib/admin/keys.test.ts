import { describe, it, expect, vi, beforeEach } from "vitest";

// `vi.hoisted` is required because `vi.mock` factories are hoisted above
// imports, so the mocks below can't close over an ordinary module-scope
// `const` declared after them — same reasoning as `lib/admin/members.test.ts`.
const { fromMock, listUsersMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  listUsersMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: fromMock,
    auth: { admin: { listUsers: listUsersMock } },
  }),
}));

import { hashKey } from "@/lib/auth/api-key";
import { listKeys, issueKey, revokeKey } from "@/lib/admin/keys";

type Row = Record<string, unknown>;

// Captures routed BY TABLE NAME (and operation), not by payload shape — same
// discipline `lib/admin/invite.test.ts` and `lib/admin/members.test.ts`
// follow, for the same reason: a select and a write on the same table must
// never be confused with one another just because a payload happens to look
// a certain way.
let insertedRow: Row | undefined;
let updatedRow: Row | undefined;
let updateFilters: Row | undefined;
let listFilters: Row;
let deleteMock: ReturnType<typeof vi.fn<() => void>>;
let existingKeyRows: Row[];

/**
 * A minimal stand-in for the subset of the supabase-js query-builder chain
 * `lib/admin/keys.ts` actually uses: `.select(...).eq(...).is(...).order(...)`,
 * `.insert(...)`, and `.update(...).eq(...).eq(...)`, each awaited directly
 * (no `.single()`/`.maybeSingle()`), exactly like the real client whose
 * query builder is itself a thenable.
 */
function makeBuilder(table: string) {
  if (table !== "api_keys") throw new Error(`unexpected table ${table}`);

  const filters: Row = {};
  let op: "select" | "insert" | "update" | "delete" = "select";
  let payload: Row | undefined;

  const builder = {
    select(_cols?: string) {
      op = "select";
      return builder;
    },
    insert(p: Row) {
      op = "insert";
      payload = p;
      return builder;
    },
    update(p: Row) {
      op = "update";
      payload = p;
      return builder;
    },
    delete() {
      op = "delete";
      deleteMock();
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
    order(_col: string, _opts?: Record<string, unknown>) {
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
    if (op === "select") {
      listFilters = { ...filters };
      return { data: existingKeyRows, error: null };
    }
    if (op === "insert") {
      insertedRow = payload;
      return { data: null, error: null };
    }
    if (op === "update") {
      updatedRow = payload;
      updateFilters = { ...filters };
      return { data: null, error: null };
    }
    throw new Error(`unexpected op ${op} on ${table}`);
  }

  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedRow = undefined;
  updatedRow = undefined;
  updateFilters = undefined;
  listFilters = {};
  existingKeyRows = [];
  deleteMock = vi.fn();

  fromMock.mockImplementation((table: string) => makeBuilder(table));
  listUsersMock.mockResolvedValue({
    data: { users: [{ id: "u1", email: "u1@example.com" }] },
    error: null,
  });
});

describe("issueKey", () => {
  it("stores the hash and prefix, never the key itself", async () => {
    const { key } = await issueKey({
      orgId: "o1",
      orgSlug: "contoso",
      userId: "u1",
      label: "laptop",
    });
    expect(JSON.stringify(insertedRow)).not.toContain(key);
    expect(insertedRow?.hash).toBe(hashKey(key));
    expect(insertedRow?.prefix).toBe(key.split(".")[0]);
  });

  it("mints a key bound to the org by its own prefix", async () => {
    const { key } = await issueKey({
      orgId: "o1",
      orgSlug: "contoso",
      userId: "u1",
      label: "laptop",
    });
    expect(key).toMatch(/^kngw_contoso_[0-9a-f]+\./);
  });
});

describe("listKeys", () => {
  it("lists only live keys", async () => {
    await listKeys("o1");
    expect(listFilters.revoked_at).toBeNull();
  });
});

describe("revokeKey", () => {
  it("revokes by setting revoked_at, never by deleting the row", async () => {
    await revokeKey("o1", "k1");
    expect(deleteMock).not.toHaveBeenCalled();
    expect(updatedRow).toMatchObject({ revoked_at: expect.any(String) });
  });

  it("scopes revocation to the org, so one org cannot revoke another's key", async () => {
    await revokeKey("o1", "k1");
    expect(updateFilters).toMatchObject({ id: "k1", org_id: "o1" });
  });
});
