import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Minimal in-memory query-builder stand-in, matching the pattern already used
 * by app/oauth/token/route.test.ts — duplicated rather than shared so this
 * file stays self-contained.
 */
type Row = Record<string, unknown>;

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private predicates: Array<(row: Row) => boolean> = [];
  private selectCols: string | null = null;

  constructor(private rows: Row[]) {}

  select(cols?: string) {
    this.selectCols = cols ?? null;
    return this;
  }
  eq(col: string, val: unknown) {
    this.predicates.push((row) => row[col] === val);
    return this;
  }

  private matched(): Row[] {
    void this.selectCols;
    return this.rows.filter((row) => this.predicates.every((p) => p(row)));
  }

  then<T1, T2>(
    onfulfilled?: ((v: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve({ data: this.matched(), error: null }).then(onfulfilled, onrejected);
  }

  async maybeSingle() {
    const rows = this.matched();
    return { data: rows[0] ?? null, error: null };
  }
}

const { fakeDb, resetDb } = vi.hoisted(() => {
  const db: Record<string, Row[]> = {
    oauth_clients: [],
    organizations: [],
    memberships: [],
    role_assignments: [],
  };
  return {
    fakeDb: db,
    resetDb: () => {
      db.oauth_clients = [];
      db.organizations = [];
      db.memberships = [];
      db.role_assignments = [];
    },
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (!fakeDb[table]) fakeDb[table] = [];
      return new FakeQuery(fakeDb[table]);
    },
  }),
}));

import {
  AUTHORIZE_ERRORS,
  appendQueryParams,
  checkAuthorizeRequest,
  parseAuthorizeParams,
  resolveOrgAccess,
  type AuthorizeParams,
} from "@/lib/oauth/authorize-request";

const ISSUER = "https://gw.example.com";
const REDIRECT = "http://127.0.0.1:6274/callback";
const RESOURCE = `${ISSUER}/mcp/contoso`;

/** A request that passes every pure check, so each test varies one field. */
function valid(over: Partial<AuthorizeParams> = {}): AuthorizeParams {
  return {
    response_type: "code",
    client_id: "oc_test",
    redirect_uri: REDIRECT,
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    scope: "mcp:gateway",
    state: "xyz",
    resource: RESOURCE,
    ...over,
  };
}

describe("parseAuthorizeParams", () => {
  it("reads the eight fields out of a query string", () => {
    const sp = new URLSearchParams(
      "response_type=code&client_id=oc_1&redirect_uri=https%3A%2F%2Fx.test%2Fcb" +
        "&code_challenge=abc&code_challenge_method=S256&scope=mcp%3Agateway&state=s&resource=https%3A%2F%2Fa%2Fmcp",
    );
    expect(parseAuthorizeParams(sp)).toEqual({
      response_type: "code",
      client_id: "oc_1",
      redirect_uri: "https://x.test/cb",
      code_challenge: "abc",
      code_challenge_method: "S256",
      scope: "mcp:gateway",
      state: "s",
      resource: "https://a/mcp",
    });
  });

  it("reads the same fields out of a form body", () => {
    const form = new FormData();
    form.set("response_type", "code");
    form.set("client_id", "oc_1");
    // A file part must not become the string "[object File]" downstream.
    form.set("scope", new File([""], "scope.txt"));
    const params = parseAuthorizeParams(form);
    expect(params.client_id).toBe("oc_1");
    expect(params.scope).toBe("");
  });

  it("defaults absent fields to empty strings, never undefined", () => {
    const params = parseAuthorizeParams(new URLSearchParams());
    expect(Object.values(params).every((v) => v === "")).toBe(true);
  });
});

describe("checkAuthorizeRequest — pure validation", () => {
  it("rejects a response_type other than code", async () => {
    const r = await checkAuthorizeRequest(valid({ response_type: "token" }), ISSUER);
    expect(r).toEqual({ ok: false, code: "bad_response_type" });
  });

  // The GET half rejected these two and the POST half didn't. That drift is
  // the reason this module exists: the consent screen refusing to render a
  // request the submit handler would have accepted is a check that isn't one.
  it("rejects a missing client_id", async () => {
    const r = await checkAuthorizeRequest(valid({ client_id: "" }), ISSUER);
    expect(r).toEqual({ ok: false, code: "missing_client_id" });
  });

  it("rejects a missing redirect_uri", async () => {
    const r = await checkAuthorizeRequest(valid({ redirect_uri: "" }), ISSUER);
    expect(r).toEqual({ ok: false, code: "missing_redirect_uri" });
  });

  it("requires PKCE", async () => {
    expect(await checkAuthorizeRequest(valid({ code_challenge: "" }), ISSUER)).toEqual({
      ok: false,
      code: "bad_code_challenge",
    });
  });

  it("requires S256 specifically — plain is not accepted", async () => {
    const r = await checkAuthorizeRequest(valid({ code_challenge_method: "plain" }), ISSUER);
    expect(r).toEqual({ ok: false, code: "bad_code_challenge" });
  });

  // The gateway adaptation: `resource` is mandatory (RFC 8707, MCP spec), and
  // it is what names the org — so a request that omits it cannot be issued a
  // code for any org at all.
  it("rejects a missing resource with missing_resource", async () => {
    const r = await checkAuthorizeRequest(valid({ resource: "" }), ISSUER);
    expect(r).toEqual({ ok: false, code: "missing_resource" });
  });

  it("rejects a resource indicator naming a different gateway", async () => {
    const r = await checkAuthorizeRequest(
      valid({ resource: "https://evil.test/mcp/contoso" }),
      ISSUER,
    );
    expect(r).toEqual({ ok: false, code: "resource_mismatch" });
  });

  it("rejects a resource that doesn't parse to an (org) shape", async () => {
    const r = await checkAuthorizeRequest(valid({ resource: `${ISSUER}/not-mcp` }), ISSUER);
    expect(r).toEqual({ ok: false, code: "resource_mismatch" });
  });
});

describe("checkAuthorizeRequest — client lookup", () => {
  beforeEach(() => {
    resetDb();
    fakeDb.oauth_clients.push(
      { client_id: "oc_test", client_name: "Test Client", redirect_uris: [REDIRECT], registered_at: new Date().toISOString(), disabled_at: null },
      { client_id: "oc_disabled", client_name: "Retired Client", redirect_uris: [REDIRECT], registered_at: new Date().toISOString(), disabled_at: new Date().toISOString() },
    );
  });

  it("accepts a registered client and returns its row plus the parsed org", async () => {
    const r = await checkAuthorizeRequest(valid(), ISSUER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.client.client_name).toBe("Test Client");
    expect(r.orgSlug).toBe("contoso");
    expect(r.appSlug).toBeNull();
  });

  it("parses an (org, app) resource and returns both", async () => {
    const r = await checkAuthorizeRequest(
      valid({ resource: `${ISSUER}/mcp/contoso/dispatch` }),
      ISSUER,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.orgSlug).toBe("contoso");
    expect(r.appSlug).toBe("dispatch");
  });

  it("rejects an unregistered client_id", async () => {
    const r = await checkAuthorizeRequest(valid({ client_id: "oc_nope" }), ISSUER);
    expect(r).toEqual({ ok: false, code: "unknown_client" });
  });

  it("rejects a disabled client", async () => {
    const r = await checkAuthorizeRequest(valid({ client_id: "oc_disabled" }), ISSUER);
    expect(r).toEqual({ ok: false, code: "client_disabled" });
  });

  it("rejects a redirect_uri the client never registered", async () => {
    const r = await checkAuthorizeRequest(
      valid({ redirect_uri: "https://evil.test/cb" }),
      ISSUER,
    );
    expect(r).toEqual({ ok: false, code: "bad_redirect_uri" });
  });

  it("matches redirect_uri exactly — a path suffix is not a match", async () => {
    const r = await checkAuthorizeRequest(
      valid({ redirect_uri: `${REDIRECT}/extra` }),
      ISSUER,
    );
    expect(r).toEqual({ ok: false, code: "bad_redirect_uri" });
  });
});

describe("appendQueryParams", () => {
  it("skips undefined and empty values so state= is never emitted bare", () => {
    const url = appendQueryParams(REDIRECT, { code: "abc", state: undefined });
    expect(url).toBe("http://127.0.0.1:6274/callback?code=abc");
    expect(appendQueryParams(REDIRECT, { code: "abc", state: "" })).toBe(url);
  });

  it("preserves a query string the redirect_uri already carried", () => {
    expect(appendQueryParams("https://x.test/cb?a=1", { code: "abc" })).toBe(
      "https://x.test/cb?a=1&code=abc",
    );
  });

  it("percent-encodes values rather than splicing them in raw", () => {
    const url = new URL(appendQueryParams(REDIRECT, { state: "a b&c=d" }));
    expect(url.searchParams.get("state")).toBe("a b&c=d");
  });
});

describe("AUTHORIZE_ERRORS", () => {
  it("has copy for every code the checker can return", () => {
    // The decision handler passes a code through a redirect and the error page
    // looks it up; a code with no entry would render as a generic failure and
    // quietly lose the real reason.
    for (const [code, entry] of Object.entries(AUTHORIZE_ERRORS)) {
      expect(entry.title.length, code).toBeGreaterThan(0);
      expect(entry.detail.length, code).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveOrgAccess — the org-membership binding. THE critical negative test
// for this phase, mirroring phase 1's "a field_tech cannot reach
// account_balance through any tool" in spirit: merging past it must be
// impossible.
// ---------------------------------------------------------------------------

describe("resolveOrgAccess", () => {
  const ORG_A = "org-a-id";
  const ORG_B = "org-b-id";
  const CONTOSO = "contoso-id";

  beforeEach(() => {
    resetDb();
    fakeDb.organizations.push(
      { id: ORG_A, slug: "org-a" },
      { id: ORG_B, slug: "org-b" },
      { id: CONTOSO, slug: "contoso" },
    );
    fakeDb.memberships.push(
      { user_id: "user-in-org-a", org_id: ORG_A },
      { user_id: "member-no-roles", org_id: CONTOSO },
    );
    fakeDb.role_assignments.push({ user_id: "user-in-org-a", org_id: ORG_A, role: "dispatcher" });
  });

  it("refuses a user who has no membership in the org named by `resource`", async () => {
    const result = await resolveOrgAccess("user-in-org-a", "org-b");
    expect(result.ok).toBe(false);
  });

  it("refuses a user with a membership but no role assignments", async () => {
    const result = await resolveOrgAccess("member-no-roles", "contoso");
    expect(result.ok).toBe(false);
  });

  it("refuses an org slug that does not exist", async () => {
    const result = await resolveOrgAccess("user-1", "no-such-org");
    expect(result.ok).toBe(false);
  });

  it("accepts a user with both a membership and at least one role assignment", async () => {
    const result = await resolveOrgAccess("user-in-org-a", "org-a");
    expect(result).toEqual({ ok: true, orgId: ORG_A, roles: ["dispatcher"] });
  });
});
