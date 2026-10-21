import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { hashAuthCode, pkceChallengeFromVerifier } from "@/lib/oauth/codes";

/**
 * Same minimal in-memory query-builder stand-in as lib/oauth/tokens.test.ts
 * (duplicated rather than shared, so this file stays self-contained). It
 * backs the mocked `createAdminClient()`, so the route under test drives the
 * REAL `lib/oauth/tokens.ts` and `lib/oauth/codes.ts` against it -- this is
 * an integration test of the whole exchange, not a test of a mocked
 * `issueOauthTokens`. That matters here specifically: the assertion that a
 * valid exchange returns a `kngw_<org>_...`-prefixed token is only meaningful
 * if the real minting code ran.
 *
 * `lib/oauth/cleanup.ts` IS mocked -- its sweep is fire-and-forget, sampled,
 * and irrelevant to what this file is testing; leaving it real would make
 * the suite occasionally (2% of the time) race a background delete against
 * assertions.
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

const { fakeDb, resetDb } = vi.hoisted(() => {
  const db: Record<string, Record<string, unknown>[]> = {
    api_keys: [],
    organizations: [],
    oauth_authorization_codes: [],
    oauth_clients: [{ client_id: "oc_x", disabled_at: null }],
  };
  return {
    fakeDb: db,
    resetDb: () => {
      db.api_keys = [];
      db.organizations = [];
      db.oauth_authorization_codes = [];
      db.oauth_clients = [{ client_id: "oc_x", disabled_at: null }];
    },
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      let counter = 0;
      if (!fakeDb[table]) fakeDb[table] = [];
      return new FakeQuery(fakeDb[table], fakeDb, () => `${table}-${++counter}-${Math.random()}`);
    },
  }),
}));

const { sweepMock } = vi.hoisted(() => ({ sweepMock: vi.fn(async () => {}) }));
vi.mock("@/lib/oauth/cleanup", () => ({ sweepExpiredCodes: sweepMock, sweepUnusedClients: vi.fn(async () => {}) }));

import { POST } from "@/app/oauth/token/route";

const ISSUER = "https://gw.example.com";
const ORG = { id: "org-1", slug: "contoso" };
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // RFC 7636 App. B vector
const CHALLENGE = pkceChallengeFromVerifier(VERIFIER);
const RESOURCE = `${ISSUER}/mcp/contoso`;
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

function tokenRequest(params: Record<string, string>): NextRequest {
  const body = new URLSearchParams(params).toString();
  // No content-type header set, deliberately -- exercises the route's
  // `new URLSearchParams(await req.text())` fallback branch.
  return new NextRequest(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "x-forwarded-host": "gw.example.com", "x-forwarded-proto": "https" },
    body,
  });
}

function seedCode(overrides: Partial<Record<string, unknown>> = {}) {
  const code = (overrides.__plainCode as string) ?? "test-auth-code";
  const row = {
    code_hash: hashAuthCode(code),
    client_id: "oc_x",
    user_id: "user-1",
    org_id: ORG.id,
    redirect_uri: REDIRECT_URI,
    scopes: ["mcp:gateway"],
    code_challenge: CHALLENGE,
    resource: RESOURCE,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    consumed_at: null,
    ...overrides,
  };
  delete (row as Record<string, unknown>).__plainCode;
  fakeDb.oauth_authorization_codes.push(row);
  return code;
}

describe("POST /oauth/token -- authorization_code", () => {
  beforeEach(() => {
    resetDb();
    fakeDb.organizations.push({ id: ORG.id, slug: ORG.slug });
    sweepMock.mockClear();
    sweepMock.mockImplementation(async () => {});
  });

  it("a valid exchange returns an access token whose prefix carries the code's org", async () => {
    const code = seedCode();
    const res = await POST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "oc_x",
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        resource: RESOURCE,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.access_token.startsWith("kngw_contoso_")).toBe(true);
    expect(json.refresh_token.startsWith("kngwr_")).toBe(true);
    expect(json.token_type).toBe("Bearer");
    expect(json.expires_in).toBe(60 * 60 * 24 * 30);
  });

  it("refuses to exchange a code for a client that has been disabled", async () => {
    fakeDb.oauth_clients = [{ client_id: "oc_x", disabled_at: new Date().toISOString() }];
    const code = seedCode();
    const res = await POST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "oc_x",
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        resource: RESOURCE,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    expect(fakeDb.api_keys).toEqual([]);
  });

  it("canonicalizes an accepted trailing slash before binding the issued token", async () => {
    const resourceWithSlash = `${RESOURCE}/`;
    const code = seedCode({ resource: resourceWithSlash });
    const res = await POST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "oc_x",
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        resource: resourceWithSlash,
      }),
    );
    expect(res.status).toBe(200);
    expect(fakeDb.api_keys[0].oauth_resource).toBe(RESOURCE);
  });

  it("a sweep failure never fails the token exchange", async () => {
    sweepMock.mockImplementation(async () => {
      throw new Error("sweep exploded");
    });
    const code = seedCode();
    const res = await POST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "oc_x",
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        resource: RESOURCE,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.access_token.startsWith("kngw_contoso_")).toBe(true);
  });

  it("rejects a mismatched code_verifier with invalid_grant", async () => {
    const code = seedCode();
    const res = await POST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "oc_x",
        redirect_uri: REDIRECT_URI,
        code_verifier: "wrong-verifier",
        resource: RESOURCE,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("rejects a reused (already-consumed) code with invalid_grant", async () => {
    const code = seedCode({ consumed_at: new Date().toISOString() });
    const res = await POST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "oc_x",
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        resource: RESOURCE,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("rejects an expired code with invalid_grant", async () => {
    const code = seedCode({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const res = await POST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "oc_x",
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        resource: RESOURCE,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("rejects a resource that differs from the code's stored resource", async () => {
    const code = seedCode();
    const res = await POST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "oc_x",
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        resource: `${ISSUER}/mcp/some-other-org`,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("rejects a code whose stored resource is null", async () => {
    const code = seedCode({ resource: null });
    const res = await POST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "oc_x",
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        resource: RESOURCE,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("rejects a request missing the resource parameter with invalid_request", async () => {
    const code = seedCode();
    const res = await POST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "oc_x",
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
  });

  it("rejects an unknown code with invalid_grant", async () => {
    const res = await POST(
      tokenRequest({
        grant_type: "authorization_code",
        code: "never-issued",
        client_id: "oc_x",
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        resource: RESOURCE,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });
});

describe("POST /oauth/token -- refresh_token", () => {
  beforeEach(() => {
    resetDb();
    fakeDb.organizations.push({ id: ORG.id, slug: ORG.slug });
    sweepMock.mockClear();
    sweepMock.mockImplementation(async () => {});
  });

  it("rotates a valid refresh token for a new access/refresh pair bound to the same org", async () => {
    const code = seedCode();
    const first = await POST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "oc_x",
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        resource: RESOURCE,
      }),
    );
    const { refresh_token } = await first.json();

    const res = await POST(
      tokenRequest({
        grant_type: "refresh_token",
        refresh_token,
        client_id: "oc_x",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.access_token.startsWith("kngw_contoso_")).toBe(true);
    expect(json.refresh_token).not.toBe(refresh_token);
  });

  it("rejects a replayed refresh token with invalid_grant", async () => {
    const code = seedCode();
    const first = await POST(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: "oc_x",
        redirect_uri: REDIRECT_URI,
        code_verifier: VERIFIER,
        resource: RESOURCE,
      }),
    );
    const { refresh_token } = await first.json();

    await POST(tokenRequest({ grant_type: "refresh_token", refresh_token, client_id: "oc_x" }));
    const replay = await POST(
      tokenRequest({ grant_type: "refresh_token", refresh_token, client_id: "oc_x" }),
    );
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid_grant");
  });

  it("rejects an unsupported grant_type", async () => {
    const res = await POST(tokenRequest({ grant_type: "password" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_grant_type");
  });
});
