import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog, checkAdapterRegistry } from "@/lib/config/load";
import { checkToolInputSchema } from "@/lib/mcp/handler";
import type { AppEntry } from "@/lib/types";

// A role whose field allowlist may use wildcards. The config schema has no way to
// mark a role "unrestricted" structurally (rolesConfigSchema.fieldRuleSchema is just
// `{ allow: string[] }`), so the exemption is named explicitly here rather than inferred.
//
// Keyed on `${org}/${app}/${role}`, NOT the bare role name: a bare-name exemption
// (`new Set(["owner"])`) would silently exempt *any* role literally called "owner" in
// *any* org, including one that grants only a handful of restricted fields under that
// name — nobody would have decided that exemption, it would just fall out of a name
// collision. Scoping to the full triple means a new org's "owner" role is linted like
// any other role unless someone adds it here explicitly.
const UNRESTRICTED_ROLES = new Set([
  // The demo app's owner reads every field DummyJSON returns; its `viewer` role is the
  // restricted counterpart and is linted normally.
  "demo/helloworld/owner",
]);

/**
 * Every `${org}/${app}/${role} field pattern "${allow entry}"` violation in
 * `catalog`: an allow entry, for a role not in `unrestricted`, that is a bare
 * `"*"` or ends in `".*"` — a subtree/full wildcard, which `filterFields`
 * grants unconditionally (see `lib/policy/filter.ts`). Exported as a
 * standalone function (rather than left inline inside one `it`) so the same
 * logic can be exercised against a synthetic catalog in the
 * cross-org-scoping test below, not just the real committed one.
 */
function restrictedWildcardViolations(
  catalog: Map<string, AppEntry>,
  unrestricted: Set<string>,
): string[] {
  const violations: string[] = [];
  for (const entry of catalog.values()) {
    for (const [roleName, role] of Object.entries(entry.roles.roles)) {
      const key = `${entry.org}/${entry.app}/${roleName}`;
      if (unrestricted.has(key)) continue;
      for (const [pattern, rule] of Object.entries(role.fields)) {
        for (const allowEntry of rule.allow) {
          if (allowEntry === "*" || allowEntry.endsWith(".*")) {
            // Fix round 4, finding I: the explanation (not just which entry
            // violated) is what a role editor months from now actually needs
            // from this failure — carried in the violation string itself,
            // not left in this function's doc comment, so it survives being
            // read out of `expect(violations, ...)`'s failure message no
            // matter which test (or future caller) reports it.
            violations.push(
              `${key} field pattern "${pattern}" allows "${allowEntry}" — a subtree/full ` +
                `wildcard grants everything nested under it unconditionally (this is exactly ` +
                `the shape of the locations.*/contacts.phones.* leaks fixed in Task 12 fix ` +
                `round 1). Name the leaf fields explicitly instead.`,
            );
          }
        }
      }
    }
  }
  return violations;
}

describe("committed org configs", () => {
  it("every org config loads and cross-validates", () => {
    const catalog = loadCatalog(join(process.cwd(), "orgs"));
    expect(catalog.size).toBeGreaterThan(0);
  });

  it("every adapter in lib/adapters/registry.ts belongs to a loaded org/app", () => {
    // loadCatalog (with the real registry, its default) already refuses an unregistered
    // adapter.ts and an adapter naming an unknown tool; this is the other direction.
    expect(() => checkAdapterRegistry(loadCatalog(join(process.cwd(), "orgs")))).not.toThrow();
  });

  it("demo exposes the expected hello-world tools", () => {
    const entry = loadCatalog(join(process.cwd(), "orgs")).get("demo/helloworld")!;
    expect(entry.config.tools.map((t) => t.name).sort()).toEqual([
      "hello",
      "user_create",
      "user_get",
      "user_search",
    ]);
  });

  it("every non-GET tool is decidably a search or a write, never ambiguous", () => {
    // POST is the ambiguous verb: some upstreams' searches are POST reads and
    // their creates are POST writes. The schema refinement rejects a POST tool that
    // declares neither a `list` nor a `write` block; this pins the property
    // across every committed config, including orgs added later, and says why
    // in the failure message rather than leaving it in a zod error.
    for (const entry of loadCatalog(join(process.cwd(), "orgs")).values()) {
      for (const tool of entry.config.tools) {
        if (!tool.request || tool.request.method === "GET") continue;
        const isSearch = Boolean(tool.list);
        const isWrite = Boolean(tool.write);
        expect(
          isSearch !== isWrite,
          `${entry.org}/${entry.app}: ${tool.name} is a ${tool.request.method} tool declaring ` +
            `${isSearch && isWrite ? "BOTH a list and a write block" : "neither a list nor a write block"} — ` +
            `its effect must be decidable from its config alone`,
        ).toBe(true);
      }
    }
  });

  it("every write tool's fields argument is governed by a role write allowlist", () => {
    // The pairing that actually enforces write policy: `write.fieldsFrom`
    // names the argument, and a role's `writes` entry names which of its keys
    // may be set. `lib/config/load.ts` fails the build when a role grants a
    // write tool it has no `writes` rule for, so reaching this assertion at
    // all means loadCatalog already accepted the pairing — this pins that
    // every committed write tool IS in fact reachable by some role with a
    // non-empty allowlist, rather than being dead config.
    for (const entry of loadCatalog(join(process.cwd(), "orgs")).values()) {
      for (const tool of entry.config.tools) {
        if (!tool.write) continue;
        const governing = Object.values(entry.roles.roles).filter((role) =>
          Object.keys(role.writes ?? {}).length > 0,
        );
        expect(
          governing.length,
          `${entry.org}/${entry.app}: ${tool.name} is a write tool but no role declares any ` +
            `"writes" allowlist`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("no write allowlist anywhere uses a wildcard", () => {
    // The schema rejects this, so this is a second, independent statement of
    // the rule against the REAL committed configs: reading and writing are
    // not symmetric, and a wildcard write grants fields nobody reviewed —
    // including ones the vendor adds after the review.
    for (const entry of loadCatalog(join(process.cwd(), "orgs")).values()) {
      for (const [roleName, role] of Object.entries(entry.roles.roles)) {
        for (const [pattern, rule] of Object.entries(role.writes ?? {})) {
          for (const field of rule.allow) {
            expect(
              field === "*" || field.endsWith(".*"),
              `${entry.org}/${entry.app}/${roleName} writes "${pattern}" allows "${field}"`,
            ).toBe(false);
          }
        }
      }
    }
  });

  // Every tool's `input` must also satisfy `checkToolInputSchema` (lib/mcp/handler.ts),
  // which runs a second time at boot via lib/mcp/catalog.ts's getCatalog() — a schema
  // it rejects there fails the whole process, not one request. loadCatalog() alone does
  // not run this check (lib/config/schema.ts leaves `input` as a free-form record), so this
  // test closes that gap for every committed config without needing to exercise the
  // server-only-gated getCatalog() singleton from a unit test.
  it("every tool's input schema satisfies checkToolInputSchema (the boot-time gate)", () => {
    const catalog = loadCatalog(join(process.cwd(), "orgs"));
    for (const entry of catalog.values()) {
      for (const tool of entry.config.tools) {
        expect(
          checkToolInputSchema(tool),
          `${entry.org}/${entry.app}: ${tool.name}`,
        ).toBeNull();
      }
    }
  });

  // Fix round 2, finding A: `lib/policy/security.test.ts`'s structural
  // "every output leaf path is covered by the allowlist" assertion cannot
  // catch a subtree wildcard — a leaked leaf sitting under the very wildcard
  // that leaked it is, by definition, "covered." (Proven directly: adding
  // `"attachments.*"` to `field_tech`'s allow list there still passes all 12
  // tests in that file.) The property that actually closes the wildcard
  // class is a config lint, not a filter test: no allow entry for a
  // restricted role may itself BE a subtree wildcard or a bare "*", full
  // stop — independent of what any fixture happens to poison, and driven off
  // the real `loadCatalog` so it covers every org/app ever added, not just
  // the demo app.
  it("no allow entry for a restricted role is a subtree wildcard or bare '*'", () => {
    const catalog = loadCatalog(join(process.cwd(), "orgs"));
    const violations = restrictedWildcardViolations(catalog, UNRESTRICTED_ROLES);
    expect(violations, violations.join("; ")).toEqual([]);
  });

  // Fix round 3, finding E: the exemption above is scoped to
  // `demo/helloworld/owner` specifically, not to any role literally
  // named "owner". Prove that scoping actually holds by building a second,
  // synthetic org/app whose role IS named "owner" but is deliberately
  // restrictive (grants a bare `locations.*` wildcard) and confirming the
  // same lint logic still flags it — i.e. the exemption doesn't leak across
  // orgs just because two roles happen to share a name.
  it("a same-named 'owner' role in a different org/app is still linted (the exemption is not by bare name)", () => {
    const root = mkdtempSync(join(tmpdir(), "orgs-lint-scope-"));
    // Fix round 4, finding J: `mkdtempSync` never cleans up after itself, so
    // without this every test run left another `orgs-lint-scope-*` directory
    // behind in the OS temp dir. Wrapped so the directory is removed whether
    // the assertions below pass or fail.
    try {
      const dir = join(root, "acme", "demo");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "api.json"),
        JSON.stringify({
          app: "demo",
          displayName: "Demo",
          baseUrl: "https://example.test/v1",
          auth: {
            type: "oauth2_client_credentials",
            tokenUrl: "https://example.test/oauth/token",
            bodyFormat: "json",
            secrets: { client_id: "acme/demo/client_id" },
            expiry: { field: "expires_in", coerce: "number", skewSeconds: 60 },
          },
          transport: {
            minIntervalMs: 0,
            timeoutMs: 1000,
            retry: { attempts: 1, on: [], respectRetryAfter: false },
            errors: { format: "json" },
          },
          tools: [
            {
              name: "widget_get",
              description: "d",
              input: { type: "object", properties: {} },
              request: { method: "GET", path: "/widgets" },
            },
          ],
        }),
      );
      writeFileSync(
        join(dir, "roles.json"),
        JSON.stringify({
          // Same role NAME as the demo's exempt role, but this one is
          // restrictive in intent — it should not inherit the demo's
          // exemption just because they're both spelled "owner".
          roles: { owner: { tools: ["widget_get"], fields: { widget_get: { allow: ["locations.*"] } } } },
        }),
      );

      const catalog = loadCatalog(root);
      // Reuse the SAME exemption set the real lint above uses (scoped only to
      // `demo/helloworld/owner`) — if the exemption were keyed by bare
      // role name instead, this would wrongly find zero violations.
      const violations = restrictedWildcardViolations(catalog, UNRESTRICTED_ROLES);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]).toContain("acme/demo/owner");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
