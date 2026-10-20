import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { loadCatalog } from "@/lib/config/load";
import { computeGrant } from "@/lib/policy/grants";
import { filterFields } from "@/lib/policy/filter";
import { matchesPath, matchesToolPattern } from "@/lib/policy/paths";
import type { Json } from "@/lib/types";

// The critical negative test: a restricted principal must not be able to reach the fields
// their role withholds, through ANY tool, by any argument. Reviewing roles.json by eye proves
// nothing — this runs the real loader, the real grant computation and the real filter against
// a poisoned record, using the committed demo app (`orgs/demo/helloworld`). Copy this file's
// shape for every org you onboard.

const FORBIDDEN_TO_VIEWERS = ["ssn", "password", "cardNumber", "iban", "wallet", "secret_note"];

// A full DummyJSON user, plus a forbidden field nested inside every subtree the viewer's
// allowlist reaches into (`company`), so a subtree wildcard written by mistake has something
// to leak in the test, not only in production.
const poisonedUser: Json = {
  id: 1, firstName: "Ada", lastName: "Lovelace", email: "ada@example.com",
  ssn: "900-00-0000", password: "hunter2",
  bank: { cardNumber: "4111111111111111", iban: "GB00TEST" },
  crypto: { wallet: "0xabc" },
  company: {
    name: "Analytical Engines", title: "Programmer", department: "Engineering",
    secret_note: "n1",
    address: { city: "Marylebone", secret_note: "n2" },
  },
};

/** Every leaf path in `value`, as an ordered array of key segments. Arrays are
 *  transparent (never contribute a segment) — matching `lib/policy/filter.ts`'s
 *  own path model exactly, so a path from this helper can be checked directly
 *  against an allow pattern with `matchesPath`. */
function leafPaths(value: Json, path: string[] = []): string[][] {
  if (Array.isArray(value)) return value.flatMap((v) => leafPaths(v, path));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => leafPaths(v, [...path, k]));
  }
  return [path];
}

describe("demo viewer cannot reach sensitive user fields", () => {
  const entry = loadCatalog(join(process.cwd(), "orgs")).get("demo/helloworld")!;
  const grant = computeGrant(["viewer"], entry.roles, entry.config.tools);

  it("is not granted the write tool at all", () => {
    expect(grant.tools.has("user_create")).toBe(false);
  });

  for (const tool of ["user_search", "user_get"]) {
    it(`strips forbidden fields from ${tool} output`, () => {
      const out = JSON.stringify(filterFields(poisonedUser, [...grant.fields.get(tool)!]));
      for (const field of FORBIDDEN_TO_VIEWERS) {
        expect(out, `${field} leaked through ${tool}`).not.toContain(field);
      }
      // Precision check: an allowlist that stripped everything would trivially pass above.
      expect(out).toContain("Lovelace");
      expect(out).toContain("Analytical Engines");
    });

    // Structural assertion: rather than only checking the field names this file thought of,
    // walk every leaf path the filtered output contains and require each one to be selected
    // by the viewer's own allowlist. This is what makes the next subtree wildcard impossible
    // to write without a test noticing.
    it(`every leaf path in the ${tool} output is selected by viewer's own allowlist`, () => {
      const allow = [...grant.fields.get(tool)!];
      for (const path of leafPaths(filterFields(poisonedUser, allow))) {
        expect(
          allow.some((p) => matchesPath(path, p)),
          `leaf path "${path.join(".")}" in the output is not covered by any allow pattern`,
        ).toBe(true);
      }
    });
  }

  it("does not see the company address, which sits under a subtree it partly reads", () => {
    const out = filterFields(poisonedUser, [...grant.fields.get("user_get")!]) as Record<string, Json>;
    expect(JSON.stringify(out.company)).not.toContain("Marylebone");
  });

  // Defeat attempt via argument: no declared input could ask the upstream (or the gateway)
  // to return different fields. DummyJSON does support a `select` parameter; it is
  // deliberately not exposed, and filtering happens in the gateway regardless.
  it("user_search accepts no argument that could widen field selection", () => {
    const tool = entry.config.tools.find((t) => t.name === "user_search")!;
    expect(Object.keys((tool.input as { properties?: Record<string, unknown> }).properties ?? {})).toEqual(["query"]);
  });

  it("owner does see ssn, proving the test is not vacuous", () => {
    const owner = computeGrant(["owner"], entry.roles, entry.config.tools);
    const out = JSON.stringify(filterFields(poisonedUser, [...owner.fields.get("user_get")!]));
    expect(out).toContain("ssn");
  });
});

describe("roles.json union semantics", () => {
  const entry = loadCatalog(join(process.cwd(), "orgs")).get("demo/helloworld")!;

  // grants.ts: "A role's field allowlist for a tool pattern only ever applies to tools that
  // SAME role also grants via its own `tools` list." A field rule for a tool the role does
  // not grant is silently inert — configuration that looks like enforcement but isn't.
  //
  // Uses `matchesToolPattern` (lib/policy/paths.ts) rather than a hand-rolled regex, so this
  // test cannot drift from boot-time validation and runtime grant computation on what a tool
  // pattern matches.
  it("no role defines a field rule for a tool it does not grant", () => {
    for (const [roleName, role] of Object.entries(entry.roles.roles)) {
      const granted = computeGrant([roleName], entry.roles, entry.config.tools).tools;
      for (const pattern of Object.keys(role.fields)) {
        const matchesSomeGrantedTool = entry.config.tools.some(
          (t) => granted.has(t.name) && matchesToolPattern(t.name, pattern),
        );
        expect(matchesSomeGrantedTool, `role "${roleName}" field pattern "${pattern}" matches no tool it grants`).toBe(true);
      }
    }
  });

  // Holding two roles is additive (intersection would mean adding a role could remove
  // access). The combination must never expose a forbidden field the wider role alone
  // does not already expose.
  it("combining viewer + owner never exposes more than owner alone", () => {
    const ownerAlone = JSON.stringify(
      filterFields(poisonedUser, [...computeGrant(["owner"], entry.roles, entry.config.tools).fields.get("user_get")!]),
    );
    const combined = JSON.stringify(
      filterFields(
        poisonedUser,
        [...computeGrant(["viewer", "owner"], entry.roles, entry.config.tools).fields.get("user_get")!],
      ),
    );
    expect(combined).toBe(ownerAlone);
  });
});
