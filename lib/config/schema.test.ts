import { describe, it, expect } from "vitest";
import { appConfigSchema, rolesConfigSchema } from "@/lib/config/schema";

const baseApp = {
  app: "demo", displayName: "Demo", baseUrl: "https://example.test/v1",
  auth: { type: "oauth2_client_credentials", tokenUrl: "https://example.test/t",
          bodyFormat: "json", secrets: { client_id: "a", client_secret: "b" },
          expiry: { field: "expires_in", coerce: "number", skewSeconds: 60 } },
  transport: { minIntervalMs: 600, timeoutMs: 120000,
               retry: { attempts: 5, on: ["429"], respectRetryAfter: true },
               errors: { format: "html" } },
  tools: [{ name: "customer_get", description: "d", input: { type: "object" },
            request: { method: "GET", path: "/customers" } }],
};

describe("appConfigSchema", () => {
  it("accepts a valid read-only config", () => {
    expect(appConfigSchema.parse(baseApp).app).toBe("demo");
  });

  it("rejects a non-GET method (phase 1 is read-only)", () => {
    const bad = structuredClone(baseApp);
    bad.tools[0].request.method = "POST";
    expect(() => appConfigSchema.parse(bad)).toThrow();
  });

  it("rejects any unknown key on a tool", () => {
    // `compose` is an adapter.ts hook, never a config key. The runTool guard in
    // Task 9 is what rejects an adapter defining compose for a tool that also
    // declares a request block.
    const bad = structuredClone(baseApp) as Record<string, unknown>;
    (bad.tools as Record<string, unknown>[])[0].unexpected = true;
    expect(() => appConfigSchema.parse(bad)).toThrow();
  });

  it("rejects a misspelled key inside a tool's audit block", () => {
    // A one-character typo here (redacts vs redact) must fail loudly, not
    // parse clean with the field silently dropped -- a dropped redact list
    // reads as enforcement while disabling it.
    const bad = structuredClone(baseApp) as Record<string, unknown>;
    (bad.tools as Record<string, unknown>[])[0].audit = { redacts: ["client_secret"] };
    expect(() => appConfigSchema.parse(bad)).toThrow();
  });

  it("rejects a misspelled key inside a tool's request block", () => {
    const bad = structuredClone(baseApp) as Record<string, unknown>;
    const request = (bad.tools as Record<string, unknown>[])[0].request as Record<string, unknown>;
    request.qeury = { a: "b" };
    expect(() => appConfigSchema.parse(bad)).toThrow();
  });

  it("rejects transport.errors.extract — removed (\"ALSO FOLD IN\", Task 12 final review): read by nothing", () => {
    // `lib/http/client.ts`'s `summarize` always runs its sentence-extraction heuristic when
    // `format === "html"`, regardless of any `extract` value — the key configured nothing.
    // `.strict()` here is what turns a config author still writing it into a build failure
    // instead of a silently-ignored no-op.
    const bad = structuredClone(baseApp) as Record<string, unknown>;
    (bad.transport as Record<string, unknown>).errors = { format: "html", extract: "sentence" };
    expect(() => appConfigSchema.parse(bad)).toThrow();
  });
});

describe("appConfigSchema pagination (discriminated union on style)", () => {
  const withList = (pagination: unknown) => {
    const cfg = structuredClone(baseApp) as Record<string, unknown>;
    (cfg.tools as Record<string, unknown>[])[0] = {
      name: "customer_search",
      description: "d",
      input: { type: "object" },
      request: { method: "GET", path: "/customers" },
      list: { itemsAt: "items", pagination },
    };
    return cfg;
  };

  it("accepts page-style pagination with no params (Contoso's current shape)", () => {
    const cfg = withList({ style: "page", perPage: 50, maxPages: 4, pageCountAt: "_meta.pageCount" });
    expect(() => appConfigSchema.parse(cfg)).not.toThrow();
  });

  it("accepts offset-style pagination with default or custom param names", () => {
    const cfg = withList({ style: "offset", perPage: 200, maxPages: 5, totalCountAt: "total" });
    expect(() => appConfigSchema.parse(cfg)).not.toThrow();

    const withParams = withList({
      style: "offset",
      perPage: 200,
      maxPages: 5,
      params: { limit: "limit", offset: "offset" },
    });
    expect(() => appConfigSchema.parse(withParams)).not.toThrow();
  });

  it("rejects an offset tool declaring a page-style param name", () => {
    // The whole point of the discriminated union: an offset tool must not be
    // able to declare a `page` parameter name, or vice versa. A cross-style
    // `params` key fails `.strict()` on the offset branch rather than
    // silently paging wrong.
    const cfg = withList({
      style: "offset",
      perPage: 200,
      maxPages: 5,
      params: { page: "page" },
    });
    expect(() => appConfigSchema.parse(cfg)).toThrow();
  });

  it("rejects a page tool declaring an offset-style param name", () => {
    const cfg = withList({
      style: "page",
      perPage: 50,
      maxPages: 4,
      params: { offset: "offset" },
    });
    expect(() => appConfigSchema.parse(cfg)).toThrow();
  });

  it("accepts cursor-style pagination with a cursorAt path (HubSpot's shape)", () => {
    const cfg = withList({
      style: "cursor",
      perPage: 100,
      maxPages: 5,
      cursorAt: "paging.next.after",
    });
    expect(() => appConfigSchema.parse(cfg)).not.toThrow();

    const withParams = withList({
      style: "cursor",
      perPage: 100,
      maxPages: 5,
      cursorAt: "paging.next.after",
      params: { limit: "limit", cursor: "after" },
    });
    expect(() => appConfigSchema.parse(withParams)).not.toThrow();
  });

  it("rejects a cursor tool with no cursorAt", () => {
    // Not a style nit: with no cursorAt the runtime finds no next-page token,
    // stops after one page, and reports the result COMPLETE — silent
    // truncation. Required at the schema, so it fails the build instead.
    const cfg = withList({ style: "cursor", perPage: 100, maxPages: 5 });
    expect(() => appConfigSchema.parse(cfg)).toThrow();
  });

  it("rejects a cursor tool declaring a page-style param name or a pageCountAt", () => {
    // Same discriminated-union property the offset/page cases above assert.
    // A cursor API has no page count to read, so `pageCountAt` on this branch
    // would be a truncation signal that never fires.
    expect(() =>
      appConfigSchema.parse(
        withList({ style: "cursor", perPage: 100, maxPages: 5, cursorAt: "a.b", params: { page: "page" } }),
      ),
    ).toThrow();
    expect(() =>
      appConfigSchema.parse(
        withList({ style: "cursor", perPage: 100, maxPages: 5, cursorAt: "a.b", pageCountAt: "_meta.pageCount" }),
      ),
    ).toThrow();
  });

  it("rejects an unrecognized style", () => {
    const cfg = withList({ style: "keyset", perPage: 50, maxPages: 4 });
    expect(() => appConfigSchema.parse(cfg)).toThrow();
  });
});

describe("appConfigSchema request method (search vs write)", () => {
  const postTool = (extra: Record<string, unknown> = {}) => {
    const cfg = structuredClone(baseApp) as Record<string, unknown>;
    (cfg.tools as Record<string, unknown>[])[0] = {
      name: "contact_search",
      description: "d",
      input: { type: "object" },
      request: {
        method: "POST",
        path: "/crm/v3/objects/contacts/search",
        body: { filterGroups: [] },
      },
      ...extra,
    };
    return cfg;
  };

  it("accepts a POST search that declares a list block", () => {
    const cfg = postTool({
      list: {
        itemsAt: "results",
        pagination: { style: "cursor", perPage: 100, maxPages: 5, in: "body", cursorAt: "paging.next.after" },
      },
    });
    expect(() => appConfigSchema.parse(cfg)).not.toThrow();
  });

  it("rejects a POST tool declaring neither a list nor a write block", () => {
    // POST is the ambiguous verb — a search and a create look identical from
    // the method alone — so a tool that declares neither block has an effect
    // nothing can determine, and fails the build rather than being guessed at.
    expect(() => appConfigSchema.parse(postTool())).toThrow(/undecidable/);
  });

  it("accepts a POST write tool (create) that declares a write block", () => {
    const cfg = postTool({
      input: { type: "object", properties: { fields: { type: "object" } }, required: ["fields"] },
      write: { fieldsFrom: "fields" },
    });
    expect(() => appConfigSchema.parse(cfg)).not.toThrow();
  });

  it("rejects a write tool that also declares a list block", () => {
    // Pairing them would make the runtime PAGE a mutation — re-submitting it
    // once per page.
    const cfg = postTool({
      input: { type: "object", properties: { fields: { type: "object" } } },
      write: { fieldsFrom: "fields" },
      list: { itemsAt: "results", pagination: { style: "cursor", perPage: 1, maxPages: 1, cursorAt: "a" } },
    });
    expect(() => appConfigSchema.parse(cfg)).toThrow(/a write tool must not declare/);
  });

  it("rejects write.fieldsFrom naming an argument the tool does not accept", () => {
    // A typo here means the caller's field bag is never found, never checked
    // against the allowlist, and never sent — a tool that silently writes
    // nothing. It must fail the build, not the customer's first write.
    const cfg = postTool({
      input: { type: "object", properties: { fields: { type: "object" } } },
      write: { fieldsFrom: "feilds" },
    });
    expect(() => appConfigSchema.parse(cfg)).toThrow(/not one of this tool's declared input properties/);
  });

  it("rejects PATCH with no write block, and accepts it with one", () => {
    // There is no such thing as a PATCH read, so the verb alone implies a
    // mutation — and a mutation with no write block has no field policy.
    const bare = structuredClone(baseApp) as Record<string, unknown>;
    (bare.tools as Record<string, unknown>[])[0] = {
      name: "contact_update",
      description: "d",
      input: { type: "object", properties: { fields: { type: "object" } } },
      request: { method: "PATCH", path: "/crm/v3/objects/contacts/{{id}}", body: { properties: "{{fields}}" } },
    };
    expect(() => appConfigSchema.parse(bare)).toThrow(/PATCH is a mutation and must declare/);

    const withWrite = structuredClone(bare) as Record<string, unknown>;
    (withWrite.tools as Record<string, unknown>[])[0].write = { fieldsFrom: "fields" };
    expect(() => appConfigSchema.parse(withWrite)).not.toThrow();
  });

  it("rejects a body on a GET, and a POST with no body", () => {
    // Both directions of the method union. A body on a GET is never sent (it
    // would read as configuration that configures nothing); a POST with no
    // body is just a slower list tool.
    const getWithBody = structuredClone(baseApp) as Record<string, unknown>;
    ((getWithBody.tools as Record<string, unknown>[])[0].request as Record<string, unknown>).body = { a: 1 };
    expect(() => appConfigSchema.parse(getWithBody)).toThrow();

    const cfg = postTool({ list: { itemsAt: "results", pagination: { style: "cursor", perPage: 1, maxPages: 1, cursorAt: "a" } } });
    delete ((cfg.tools as Record<string, unknown>[])[0].request as Record<string, unknown>).body;
    expect(() => appConfigSchema.parse(cfg)).toThrow();
  });

  it("rejects pagination.in \"body\" on a GET tool", () => {
    // The two halves live in different blocks of the same tool, so no single
    // .strict() object relates them — the refinement does.
    const cfg = structuredClone(baseApp) as Record<string, unknown>;
    (cfg.tools as Record<string, unknown>[])[0] = {
      name: "contact_list",
      description: "d",
      input: { type: "object" },
      request: { method: "GET", path: "/crm/v3/objects/contacts" },
      list: {
        itemsAt: "results",
        pagination: { style: "cursor", perPage: 100, maxPages: 5, in: "body", cursorAt: "paging.next.after" },
      },
    };
    expect(() => appConfigSchema.parse(cfg)).toThrow(/requires a POST/);
  });
});

describe("appConfigSchema auth grants", () => {
  it("accepts the refresh-token grant with a refresh_token secret (HubSpot's shape)", () => {
    const cfg = structuredClone(baseApp) as Record<string, unknown>;
    cfg.auth = {
      type: "oauth2_refresh_token",
      tokenUrl: "https://api.hubapi.test/oauth/v1/token",
      bodyFormat: "form",
      secrets: { client_id: "a", client_secret: "b", refresh_token: "c" },
      expiry: { field: "expires_in", coerce: "number", skewSeconds: 60 },
    };
    expect(() => appConfigSchema.parse(cfg)).not.toThrow();
  });

  it("rejects an auth type with no grant mapping", () => {
    // lib/adapters/auth.ts maps each declared type to a `grant_type` body
    // parameter. An unmapped type would send `grant_type: undefined` to a real
    // identity provider, so the enum and that map move together.
    const cfg = structuredClone(baseApp) as Record<string, unknown>;
    (cfg.auth as Record<string, unknown>).type = "oauth2_password";
    expect(() => appConfigSchema.parse(cfg)).toThrow();
  });

  it("accepts auth type none for an upstream that needs no credential", () => {
    const cfg = structuredClone(baseApp) as Record<string, unknown>;
    cfg.auth = { type: "none" };
    expect(() => appConfigSchema.parse(cfg)).not.toThrow();
  });

  it("rejects auth type none that still carries OAuth keys", () => {
    // A half-deleted OAuth block reads as configuration that configures nothing.
    const cfg = structuredClone(baseApp) as Record<string, unknown>;
    cfg.auth = { type: "none", tokenUrl: "https://example.test/t" };
    expect(() => appConfigSchema.parse(cfg)).toThrow();
  });

  it("rejects a config with no auth block at all", () => {
    // Absent auth must not mean "none": a config that forgot it fails the build.
    const cfg = structuredClone(baseApp) as Record<string, unknown>;
    delete cfg.auth;
    expect(() => appConfigSchema.parse(cfg)).toThrow();
  });
});

describe("rolesConfigSchema write allowlists", () => {
  const withWrites = (allow: string[]) => ({
    roles: {
      editor: {
        tools: ["contact_update"],
        fields: { "*": { allow: ["id"] } },
        writes: { contact_update: { allow } },
      },
    },
  });

  it("accepts a writes allowlist naming literal fields", () => {
    expect(() => rolesConfigSchema.parse(withWrites(["firstname", "lastname"]))).not.toThrow();
  });

  it("rejects a bare '*' and a subtree wildcard in a writes allowlist", () => {
    // The asymmetry with `fields`, which DOES permit these. A wildcard read
    // exposes a field; a wildcard write lets a caller overwrite one nobody
    // reviewed — including a property the vendor adds after the review.
    expect(() => rolesConfigSchema.parse(withWrites(["*"]))).toThrow();
    expect(() => rolesConfigSchema.parse(withWrites(["properties.*"]))).toThrow();
    expect(() => rolesConfigSchema.parse(withWrites(["firstname", "*"]))).toThrow();
  });

  it("still permits a wildcard in a READ allowlist — the two are deliberately different", () => {
    const r = {
      roles: { owner: { tools: ["a"], fields: { "*": { allow: ["*"] } } } },
    };
    expect(() => rolesConfigSchema.parse(r)).not.toThrow();
  });

  it("rejects an empty writes allowlist", () => {
    // "Granted the tool, may write nothing" is a config mistake, not a
    // policy anyone writes on purpose — lib/config/load.ts rejects the same
    // shape reached by omitting the entry entirely.
    expect(() => rolesConfigSchema.parse(withWrites([]))).toThrow();
  });
});

describe("rolesConfigSchema", () => {
  it("accepts an allowlist role", () => {
    const r = { roles: { tech: { tools: ["customer_get"], fields: { "customer_*": { allow: ["id"] } } } } };
    expect(rolesConfigSchema.parse(r).roles.tech.tools).toEqual(["customer_get"]);
  });

  it("rejects a deny key", () => {
    const r = { roles: { tech: { tools: ["a"], fields: { "*": { allow: ["*"], deny: ["x"] } } } } };
    expect(() => rolesConfigSchema.parse(r)).toThrow();
  });
});
