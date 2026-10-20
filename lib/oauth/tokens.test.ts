import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { issueOauthTokens, rotateRefreshToken } from "@/lib/oauth/tokens";
import { parseKey } from "@/lib/auth/api-key";

/**
 * A minimal in-memory stand-in for the subset of the supabase-js
 * query-builder chain `lib/oauth/tokens.ts` actually uses:
 * `.from(table).insert(...).select(...).single()`,
 * `.from(table).select(...).eq(...).eq(...).eq(...).maybeSingle()`, and
 * `.from(table).update(...).eq(...).is(...).select(...)` awaited directly
 * (no `.single()`/`.maybeSingle()`) -- exactly like the real client, whose
 * query builder is itself a thenable.
 *
 * It also resolves one level of embed (`organizations(slug)`), the way
 * `rotateRefreshToken` reads the org slug back out via the `org_id` FK.
 */
type Row = Record<string, unknown>;

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private predicates: Array<(row: Row) => boolean> = [];
  private mode: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private selectCols: string | null = null;

  constructor(
    private rows: Row[],
    private db: Record<string, Row[]>,
    private nextId: () => string,
  ) {}

  select(cols?: string) {
    this.selectCols = cols ?? null;
    return this;
  }
  insert(payload: Row) {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.mode = "update";
    this.payload = payload;
    return this;
  }
  eq(col: string, val: unknown) {
    this.predicates.push((row) => row[col] === val);
    return this;
  }
  is(col: string, val: null) {
    this.predicates.push((row) => (row[col] ?? null) === val);
    return this;
  }

  private matched(): Row[] {
    return this.rows.filter((row) => this.predicates.every((p) => p(row)));
  }

  private project(row: Row): Row {
    const m = this.selectCols?.match(/(\w+)\(([\w,\s]+)\)/);
    if (!m) return { ...row };
    const [, relTable] = m;
    const related = (this.db[relTable] ?? []).find((r) => r.id === row.org_id) ?? null;
    return { ...row, [relTable]: related };
  }

  private run(): { data: Row[]; error: null } {
    if (this.mode === "insert") {
      const row: Row = { id: this.nextId(), revoked_at: null, ...this.payload };
      this.rows.push(row);
      return { data: [this.project(row)], error: null };
    }
    if (this.mode === "update") {
      const rows = this.matched();
      rows.forEach((r) => Object.assign(r, this.payload));
      return { data: rows.map((r) => this.project(r)), error: null };
    }
    return { data: this.matched().map((r) => this.project(r)), error: null };
  }

  then<T1, T2>(
    onfulfilled?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  async single() {
    const { data } = this.run();
    const row = data[0];
    return row ? { data: row, error: null } : { data: null, error: { message: "no rows" } };
  }

  async maybeSingle() {
    const { data } = this.run();
    return { data: data[0] ?? null, error: null };
  }
}

function makeFakeDb(seed: { organizations?: Row[] } = {}) {
  const db: Record<string, Row[]> = {
    api_keys: [],
    organizations: seed.organizations ?? [],
  };
  let counter = 0;
  const client = {
    from(table: string) {
      if (!db[table]) db[table] = [];
      return new FakeQuery(db[table], db, () => `key-${++counter}`);
    },
  };
  return { supabase: client as unknown as SupabaseClient, db };
}

const ORG = { id: "org-1", slug: "contoso" };
const RESOURCE = "https://gw.example.com/mcp/contoso/fieldedge";

describe("issueOauthTokens", () => {
  it("mints an access token carrying the org slug in its prefix", async () => {
    const { supabase } = makeFakeDb();
    const { access_token } = await issueOauthTokens(supabase, {
      userId: "u1",
      orgId: ORG.id,
      orgSlug: ORG.slug,
      clientId: "oc_x",
      scopes: ["mcp:gateway"],
      resource: RESOURCE,
      ttlSeconds: 3600,
    });
    // The org binding is structural: authenticateApiKey parses the org out of
    // the token itself, so an OAuth token cannot be minted without one.
    expect(access_token.startsWith("kngw_contoso_")).toBe(true);
    expect(parseKey(access_token)).not.toBeNull();
  });

  it("mints a refresh token that is NOT key-shaped", async () => {
    const { supabase } = makeFakeDb();
    const { refresh_token } = await issueOauthTokens(supabase, {
      userId: "u1",
      orgId: ORG.id,
      orgSlug: ORG.slug,
      clientId: "oc_x",
      scopes: ["mcp:gateway"],
      resource: RESOURCE,
      ttlSeconds: 3600,
    });
    expect(refresh_token.startsWith("kngwr_")).toBe(true);
    // Never presented to authenticateApiKey -- parseKey must not accept it.
    expect(parseKey(refresh_token)).toBeNull();
  });

  it("stores the row with source=oauth, the org, and a future expires_at", async () => {
    const { supabase, db } = makeFakeDb();
    const before = Date.now();
    await issueOauthTokens(supabase, {
      userId: "u1",
      orgId: ORG.id,
      orgSlug: ORG.slug,
      clientId: "oc_x",
      scopes: ["mcp:gateway"],
      resource: RESOURCE,
      ttlSeconds: 3600,
    });
    expect(db.api_keys).toHaveLength(1);
    const row = db.api_keys[0] as Record<string, unknown>;
    expect(row.source).toBe("oauth");
    expect(row.org_id).toBe(ORG.id);
    expect(row.oauth_client_id).toBe("oc_x");
    expect(row.oauth_resource).toBe(RESOURCE);
    expect(row.revoked_at).toBeNull();
    expect(new Date(row.expires_at as string).getTime()).toBeGreaterThan(before);
  });

  it("stores only hashes -- never the plaintext access or refresh token", async () => {
    const { supabase, db } = makeFakeDb();
    const { access_token, refresh_token } = await issueOauthTokens(supabase, {
      userId: "u1",
      orgId: ORG.id,
      orgSlug: ORG.slug,
      clientId: "oc_x",
      scopes: ["mcp:gateway"],
      resource: RESOURCE,
      ttlSeconds: 3600,
    });
    const row = db.api_keys[0] as Record<string, unknown>;
    const values = Object.values(row).map(String);
    expect(values).not.toContain(access_token);
    expect(values).not.toContain(refresh_token);
    expect(row.hash).toBeTruthy();
    expect(row.hash).not.toBe(access_token);
    expect(row.refresh_token_hash).toBeTruthy();
    expect(row.refresh_token_hash).not.toBe(refresh_token);
  });
});

describe("rotateRefreshToken", () => {
  it("revokes the issuing row before minting the replacement", async () => {
    const { supabase, db } = makeFakeDb({ organizations: [ORG] });
    const issued = await issueOauthTokens(supabase, {
      userId: "u1",
      orgId: ORG.id,
      orgSlug: ORG.slug,
      clientId: "oc_x",
      scopes: ["mcp:gateway"],
      resource: RESOURCE,
      ttlSeconds: 3600,
    });

    const result = await rotateRefreshToken(supabase, {
      refreshToken: issued.refresh_token,
      clientId: "oc_x",
      ttlSeconds: 3600,
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.access_token.startsWith("kngw_contoso_")).toBe(true);
    expect(result.access_token).not.toBe(issued.access_token);
    expect(result.refresh_token).not.toBe(issued.refresh_token);

    expect(db.api_keys).toHaveLength(2);
    const originalRow = db.api_keys.find((r) => r.id === issued.api_key_id) as Record<
      string,
      unknown
    >;
    const newRow = db.api_keys.find((r) => r.id === result.api_key_id) as Record<string, unknown>;
    expect(originalRow.revoked_at).not.toBeNull();
    expect(newRow.revoked_at).toBeNull();
    expect(newRow.oauth_resource).toBe(RESOURCE);
  });

  it("rejects a replayed refresh token with invalid_grant", async () => {
    const { supabase } = makeFakeDb({ organizations: [ORG] });
    const issued = await issueOauthTokens(supabase, {
      userId: "u1",
      orgId: ORG.id,
      orgSlug: ORG.slug,
      clientId: "oc_x",
      scopes: ["mcp:gateway"],
      resource: RESOURCE,
      ttlSeconds: 3600,
    });

    const first = await rotateRefreshToken(supabase, {
      refreshToken: issued.refresh_token,
      clientId: "oc_x",
      ttlSeconds: 3600,
    });
    expect(first.kind).toBe("ok");

    // Replaying the SAME (now-rotated) refresh token must fail, and must not
    // mint anything further -- per spec decision 5, no chain invalidation, just
    // a rejection.
    const replay = await rotateRefreshToken(supabase, {
      refreshToken: issued.refresh_token,
      clientId: "oc_x",
      ttlSeconds: 3600,
    });
    expect(replay).toEqual({ kind: "error", code: "invalid_grant" });
  });

  it("rejects a refresh token presented by a different client_id, without revoking it", async () => {
    const { supabase, db } = makeFakeDb({ organizations: [ORG] });
    const issued = await issueOauthTokens(supabase, {
      userId: "u1",
      orgId: ORG.id,
      orgSlug: ORG.slug,
      clientId: "oc_x",
      scopes: ["mcp:gateway"],
      resource: RESOURCE,
      ttlSeconds: 3600,
    });

    const result = await rotateRefreshToken(supabase, {
      refreshToken: issued.refresh_token,
      clientId: "oc_someone_else",
      ttlSeconds: 3600,
    });
    expect(result).toEqual({ kind: "error", code: "invalid_grant" });

    // A rejected rotation must not revoke the row -- the legitimate client
    // must still be able to use the refresh token afterward.
    const row = db.api_keys.find((r) => r.id === issued.api_key_id) as Record<string, unknown>;
    expect(row.revoked_at).toBeNull();
  });

  it("rejects an unknown refresh token with invalid_grant", async () => {
    const { supabase } = makeFakeDb({ organizations: [ORG] });
    const result = await rotateRefreshToken(supabase, {
      refreshToken: "kngwr_does-not-exist",
      clientId: "oc_x",
      ttlSeconds: 3600,
    });
    expect(result).toEqual({ kind: "error", code: "invalid_grant" });
  });
});
