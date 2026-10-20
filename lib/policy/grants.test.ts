import { describe, it, expect } from "vitest";
import { computeGrant } from "@/lib/policy/grants";
import type { RolesConfig, ToolDef } from "@/lib/types";

const tools: ToolDef[] = [
  { name: "customer_search", description: "d", input: {} },
  { name: "customer_get", description: "d", input: {} },
  { name: "invoice_get", description: "d", input: {} },
  { name: "tech_list", description: "d", input: {} },
];

const roles: RolesConfig = {
  roles: {
    field_tech: {
      tools: ["customer_search", "customer_get", "tech_list"],
      fields: { "customer_*": { allow: ["id", "customer_name", "locations.*"] } },
    },
    bookkeeper: {
      tools: ["customer_*", "invoice_*"],
      fields: {
        "customer_*": { allow: ["id", "customer_name", "account_balance"] },
        "invoice_*": { allow: ["*"] },
      },
    },
  },
};

describe("computeGrant", () => {
  it("expands wildcard tool patterns", () => {
    const g = computeGrant(["bookkeeper"], roles, tools);
    expect([...g.tools].sort()).toEqual(["customer_get", "customer_search", "invoice_get"]);
  });

  it("unions tools across roles", () => {
    const g = computeGrant(["field_tech", "bookkeeper"], roles, tools);
    expect([...g.tools].sort()).toEqual(
      ["customer_get", "customer_search", "invoice_get", "tech_list"],
    );
  });

  it("unions field allowlists across roles", () => {
    const g = computeGrant(["field_tech", "bookkeeper"], roles, tools);
    const f = g.fields.get("customer_get")!;
    expect([...f].sort()).toEqual(["account_balance", "customer_name", "id", "locations.*"]);
  });

  it("gives a tech no access to account_balance", () => {
    const g = computeGrant(["field_tech"], roles, tools);
    expect(g.fields.get("customer_get")).not.toContain("account_balance");
  });

  it("grants no fields for a tool with no matching field rule", () => {
    const g = computeGrant(["field_tech"], roles, tools);
    expect(g.fields.get("tech_list")).toEqual([]);
  });

  it("treats an unknown role as inert and reports it", () => {
    const g = computeGrant(["field_tech", "deleted_role"], roles, tools);
    expect(g.unknownRoles).toEqual(["deleted_role"]);
    expect(g.tools.has("customer_get")).toBe(true);
  });

  it("returns an empty grant for no roles", () => {
    const g = computeGrant([], roles, tools);
    expect(g.tools.size).toBe(0);
  });
});

describe("computeGrant — over-grant hunt", () => {
  it("treats a role name that collides with an Object.prototype property as inert, not fatal", () => {
    // roles.roles is parsed from JSON (a plain object), so a bare lookup of
    // roles.roles["constructor"] resolves via the prototype chain to
    // Object's constructor function instead of `undefined`. That value is
    // truthy, so a naive `if (!role)` unknown-role check would miss it, and
    // then `role.tools` (undefined on a function) would throw when iterated.
    // A role name is a mutable admin-controlled DB value — it must never be
    // able to crash grant computation, per the "unknown role is inert, never
    // fatal" requirement.
    for (const prototypeName of Object.getOwnPropertyNames(Object.prototype)) {
      expect(() => computeGrant(["field_tech", prototypeName], roles, tools)).not.toThrow();
      const g = computeGrant(["field_tech", prototypeName], roles, tools);
      expect(g.unknownRoles).toEqual([prototypeName]);
      expect([...g.tools].sort()).toEqual(["customer_get", "customer_search", "tech_list"]);
      expect(g.fields.get("customer_get")).toEqual(["id", "customer_name", "locations.*"]);
    }
  });

  it("dedupes a role name repeated in the caller's role list", () => {
    const g = computeGrant(["deleted_role", "deleted_role"], roles, tools);
    expect(g.unknownRoles).toEqual(["deleted_role"]);
  });

  it("does not widen a tool's fields via a role that does not itself grant that tool", () => {
    // billing grants only invoice_get via its own `tools` list, but its
    // `fields` map names a "customer_*" pattern. Held alongside `tech`
    // (which does grant customer_get), the wider reading would let
    // billing's rule leak onto a tool billing never exposed — ambient
    // authority nobody reviewing `billing` in isolation would predict.
    const scoped: RolesConfig = {
      roles: {
        tech: { tools: ["customer_get"], fields: { "customer_*": { allow: ["id"] } } },
        billing: {
          tools: ["invoice_get"],
          fields: { "customer_*": { allow: ["account_balance", "ssn"] } },
        },
      },
    };
    const g = computeGrant(["tech", "billing"], scoped, tools);
    expect(g.fields.get("customer_get")).toEqual(["id"]);
  });

  it("does not let a bare * field rule widen a tool the role does not grant", () => {
    const scoped: RolesConfig = {
      roles: {
        tech: { tools: ["customer_get"], fields: { "customer_*": { allow: ["id"] } } },
        overreach: { tools: ["tech_list"], fields: { "*": { allow: ["*"] } } },
      },
    };
    const g = computeGrant(["tech", "overreach"], scoped, tools);
    expect(g.fields.get("customer_get")).toEqual(["id"]);
    expect(g.fields.get("tech_list")).toEqual(["*"]);
  });

  it("still unions field rules from two roles that both grant the same tool", () => {
    const scoped: RolesConfig = {
      roles: {
        a: { tools: ["customer_search"], fields: { "customer_*": { allow: ["id"] } } },
        b: { tools: ["customer_search"], fields: { "customer_*": { allow: ["customer_name"] } } },
      },
    };
    const g = computeGrant(["a", "b"], scoped, tools);
    expect([...g.fields.get("customer_search")!].sort()).toEqual(["customer_name", "id"]);
  });
});
