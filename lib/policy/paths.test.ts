import { describe, it, expect } from "vitest";
import {
  matchesPattern,
  isPrefixOfPattern,
  matchesPath,
  isPrefixOfPath,
  matchesToolPattern,
} from "@/lib/policy/paths";

describe("matchesPattern", () => {
  it("matches an exact path", () => {
    expect(matchesPattern("customer_name", "customer_name")).toBe(true);
  });
  it("does not match a different path", () => {
    expect(matchesPattern("account_balance", "customer_name")).toBe(false);
  });
  it("matches a trailing wildcard subtree", () => {
    expect(matchesPattern("locations.city", "locations.*")).toBe(true);
    expect(matchesPattern("locations", "locations.*")).toBe(true);
  });
  it("matches nested wildcards", () => {
    expect(matchesPattern("contacts.phones.phone", "contacts.phones.*")).toBe(true);
  });
  it("does not let a wildcard escape its prefix", () => {
    expect(matchesPattern("contacts.fname", "contacts.phones.*")).toBe(false);
  });
  it("treats bare * as everything", () => {
    expect(matchesPattern("anything.nested", "*")).toBe(true);
  });
});

describe("isPrefixOfPattern", () => {
  it("is true when the path is an ancestor of the pattern", () => {
    expect(isPrefixOfPattern("contacts", "contacts.phones.*")).toBe(true);
  });
  it("is false for unrelated paths", () => {
    expect(isPrefixOfPattern("invoices", "contacts.phones.*")).toBe(false);
  });
});

describe("matchesPath", () => {
  it("matches equal-length segment arrays element-for-element", () => {
    expect(matchesPath(["locations", "city"], "locations.city")).toBe(true);
    expect(matchesPath(["locations", "state_prov"], "locations.city")).toBe(false);
  });

  it("matches a trailing wildcard at and beneath its literal prefix", () => {
    expect(matchesPath(["locations"], "locations.*")).toBe(true);
    expect(matchesPath(["locations", "city"], "locations.*")).toBe(true);
  });

  it("treats bare * as everything", () => {
    expect(matchesPath(["anything", "nested"], "*")).toBe(true);
  });

  it("never splits a single segment that happens to contain a literal dot", () => {
    // A vendor key literally named "locations.internal_credit_memo" is one
    // segment. It must not match a pattern whose segments happen to spell
    // the same characters when joined — the whole point of carrying the
    // path as string[] instead of a joined string.
    expect(matchesPath(["locations.internal_credit_memo"], "locations.*")).toBe(false);
    expect(matchesPath(["contacts.fname"], "contacts.fname")).toBe(false);
  });
});

describe("isPrefixOfPath", () => {
  it("is true when the path is a strict ancestor of the pattern's segments", () => {
    expect(isPrefixOfPath(["contacts"], "contacts.phones.*")).toBe(true);
  });
  it("is false at equal depth (not a strict ancestor)", () => {
    expect(isPrefixOfPath(["contacts", "fname"], "contacts.fname")).toBe(false);
  });
  it("is false for unrelated paths", () => {
    expect(isPrefixOfPath(["invoices"], "contacts.phones.*")).toBe(false);
  });
  it("never treats a dotted single segment as a partial-prefix match", () => {
    expect(isPrefixOfPath(["locations.internal_credit_memo"], "locations.internal_credit_memo.detail")).toBe(
      false
    );
  });
});

describe("matchesToolPattern", () => {
  // The single dialect legal for flat tool-name patterns: exact equality,
  // a bare "*" meaning everything, or a trailing "*" as a literal prefix.
  // Tool names can never contain a dot (config schema constrains them to
  // ^[a-z][a-z0-9_]*$), so the dotted "prefix.*" subtree dialect that
  // matchesPattern supports for field paths must NOT apply here.
  it("matches an exact name", () => {
    expect(matchesToolPattern("customer_get", "customer_get")).toBe(true);
    expect(matchesToolPattern("customer_get", "invoice_get")).toBe(false);
  });

  it("matches a bare trailing * as a literal prefix", () => {
    expect(matchesToolPattern("customer_get", "customer_*")).toBe(true);
    expect(matchesToolPattern("customer_search", "customer_*")).toBe(true);
    expect(matchesToolPattern("invoice_get", "customer_*")).toBe(false);
  });

  it("treats bare * as everything", () => {
    expect(matchesToolPattern("anything_at_all", "*")).toBe(true);
  });

  it("does not apply the dotted prefix.* subtree dialect to tool names", () => {
    // A role author writing "customer_get.*" (perhaps by analogy with field
    // patterns) must not thereby grant "customer_get" itself — that dialect
    // belongs to matchesPattern/matchesPath for field paths, not tool names.
    expect(matchesToolPattern("customer_get", "customer_get.*")).toBe(false);
  });
});
