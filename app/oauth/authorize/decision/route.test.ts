import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Same minimal in-memory query-builder stand-in as
 * app/oauth/token/route.test.ts and lib/oauth/authorize-request.test.ts —
 * duplicated rather than shared so this file stays self-contained.
 */
type Row = Record<string, unknown>;

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private predicates: Array<(row: Row) => boolean> = [];
  private mode: "select" | "insert" = "select";
  private payload: Row | null = null;

  constructor(
    private rows: Row[],
    private nextId: () => string,
  ) {}

  select() {
    return this;
  }
  insert(payload: Row) {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }
  eq(col: string, val: unknown) {
    this.predicates.push((row) => row[col] === val);
    return this;
  }

  private matched(): Row[] {
    return this.rows.filter((row) => this.predicates.every((p) => p(row)));
  }

  private run(): { data: Row[]; error: null } {
    if (this.mode === "insert") {
      const row: Row = { id: this.nextId(), ...this.payload };
      this.rows.push(row);
      return { data: [row], error: null };
    }
    return { data: this.matched(), error: null };
  }

  then<T1, T2>(
    onfulfilled?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  async maybeSingle() {
    const { data } = this.run();
    return { data: data[0] ?? null, error: null };
  }
}

const { fakeDb, resetDb } = vi.hoisted(() => {
  const db: Record<string, Row[]> = {
    oauth_clients: [],
    organizations: [],
    memberships: [],
    role_assignments: [],
    oauth_authorization_codes: [],
  };
  return {
    fakeDb: db,
    resetDb: () => {
      db.oauth_clients = [];
      db.organizations = [];
      db.memberships = [];
      db.role_assignments = [];
      db.oauth_authorization_codes = [];
    },
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      let counter = 0;
      if (!fakeDb[table]) fakeDb[table] = [];
      return new FakeQuery(fakeDb[table], () => `${table}-${++counter}-${Math.random()}`);
    },
  }),
}));

// Mutable per-test "session" — set by each test before the request, so the
// mocked cookie-session client can return a signed-in user or none.
const { currentUser, setUser } = vi.hoisted(() => {
  const state: { user: { id: string; email: string } | null } = { user: null };
  return {
    currentUser: state,
    setUser: (u: { id: string; email: string } | null) => {
      state.user = u;
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: currentUser.user } }),
    },
  }),
}));

import { POST } from "@/app/oauth/authorize/decision/route";

const ISSUER = "https://gw.example.com";
const CLIENT_ID = "oc_x";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const RESOURCE = `${ISSUER}/mcp/contoso`;
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function baseParams(over: Record<string, string> = {}): Record<string, string> {
  return {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "mcp:gateway",
    state: "xyz",
    resource: RESOURCE,
    decision: "allow",
    ...over,
  };
}

function decisionRequest(
  params: Record<string, string>,
  headers: Record<string, string> = {},
): NextRequest {
  const body = new URLSearchParams(params).toString();
  return new NextRequest(`${ISSUER}/oauth/authorize/decision`, {
    method: "POST",
    headers: {
      "x-forwarded-host": "gw.example.com",
      "x-forwarded-proto": "https",
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
  });
}

describe("POST /oauth/authorize/decision", () => {
  beforeEach(() => {
    resetDb();
    setUser(null);
    fakeDb.oauth_clients.push({
      client_id: CLIENT_ID,
      client_name: "Test Client",
      redirect_uris: [REDIRECT_URI],
      registered_at: new Date().toISOString(),
      disabled_at: null,
    });
    fakeDb.organizations.push({ id: "org-1", slug: "contoso" });
  });

  it("rejects a cross-origin POST with 403, before touching anything", async () => {
    setUser({ id: "user-1", email: "user@example.com" });
    fakeDb.memberships.push({ user_id: "user-1", org_id: "org-1" });
    fakeDb.role_assignments.push({ user_id: "user-1", org_id: "org-1", role: "dispatcher" });

    const res = await POST(decisionRequest(baseParams(), { origin: "https://evil.test" }));
    expect(res.status).toBe(403);
    expect(fakeDb.oauth_authorization_codes.length).toBe(0);
  });

  it("redirects decision=deny to the validated redirect_uri with error=access_denied", async () => {
    const res = await POST(decisionRequest(baseParams({ decision: "deny" })));
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(REDIRECT_URI)).toBe(true);
    expect(new URL(location).searchParams.get("error")).toBe("access_denied");
    expect(new URL(location).searchParams.get("state")).toBe("xyz");
    expect(fakeDb.oauth_authorization_codes.length).toBe(0);
  });

  // Validate-before-redirect (spec item 4): an unregistered/tampered
  // redirect_uri must never receive a redirect, on ALLOW or DENY.
  it("never redirects to an unvalidated redirect_uri — allow branch", async () => {
    setUser({ id: "user-1", email: "user@example.com" });
    fakeDb.memberships.push({ user_id: "user-1", org_id: "org-1" });
    fakeDb.role_assignments.push({ user_id: "user-1", org_id: "org-1", role: "dispatcher" });

    const res = await POST(
      decisionRequest(baseParams({ redirect_uri: "https://evil.test/cb", decision: "allow" })),
    );
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("https://evil.test")).toBe(false);
    expect(location).toContain("/oauth/authorize/error");
    expect(fakeDb.oauth_authorization_codes.length).toBe(0);
  });

  it("never redirects to an unvalidated redirect_uri — deny branch", async () => {
    const res = await POST(
      decisionRequest(baseParams({ redirect_uri: "https://evil.test/cb", decision: "deny" })),
    );
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("https://evil.test")).toBe(false);
    expect(location).toContain("/oauth/authorize/error");
  });

  // THE critical negative test for this phase: a signed-in user with no
  // membership in the org named by `resource` must get no code row and no
  // redirect to redirect_uri, through the decision route specifically (not
  // just the consent-page render).
  it("issues no code and never redirects to redirect_uri for a user with no membership in the named org", async () => {
    setUser({ id: "user-outsider", email: "outsider@example.com" });
    // Deliberately no memberships/role_assignments rows for user-outsider.

    const res = await POST(decisionRequest(baseParams({ decision: "allow" })));
    const location = res.headers.get("location") ?? "";

    expect(fakeDb.oauth_authorization_codes.length).toBe(0);
    expect(location.startsWith(REDIRECT_URI)).toBe(false);
    // Bounced back to the consent GET to re-render the access-denied screen.
    expect(location).toContain("/oauth/authorize?");
  });

  it("issues no code for a user with a membership but no role assignments", async () => {
    setUser({ id: "member-no-roles", email: "noroles@example.com" });
    fakeDb.memberships.push({ user_id: "member-no-roles", org_id: "org-1" });
    // No role_assignments row.

    const res = await POST(decisionRequest(baseParams({ decision: "allow" })));
    const location = res.headers.get("location") ?? "";

    expect(fakeDb.oauth_authorization_codes.length).toBe(0);
    expect(location.startsWith(REDIRECT_URI)).toBe(false);
  });

  it("bounces to /login?next=… when the session expired between render and submit", async () => {
    setUser(null);
    const res = await POST(decisionRequest(baseParams({ decision: "allow" })));
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login?next=");
    expect(fakeDb.oauth_authorization_codes.length).toBe(0);
  });

  it("a user with membership AND a role assignment gets a code row bound to the org, and is redirected to redirect_uri", async () => {
    setUser({ id: "user-1", email: "user@example.com" });
    fakeDb.memberships.push({ user_id: "user-1", org_id: "org-1" });
    fakeDb.role_assignments.push({ user_id: "user-1", org_id: "org-1", role: "dispatcher" });

    const res = await POST(decisionRequest(baseParams({ decision: "allow" })));
    const location = res.headers.get("location") ?? "";

    expect(fakeDb.oauth_authorization_codes.length).toBe(1);
    expect(fakeDb.oauth_authorization_codes[0].org_id).toBe("org-1");
    expect(fakeDb.oauth_authorization_codes[0].resource).toBe(RESOURCE);
    expect(location.startsWith(REDIRECT_URI)).toBe(true);
    expect(new URL(location).searchParams.get("code")).toBeTruthy();
  });
});
