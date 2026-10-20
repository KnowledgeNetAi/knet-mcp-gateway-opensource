import { describe, it, expect } from "vitest";
import { filterFields } from "@/lib/policy/filter";
import type { Json } from "@/lib/types";

const customer: Json = {
  id: 1001,
  customer_name: "Test Customer",
  account_balance: 4200,
  credit_rating: "B",
  private_notes: "slow payer",
  contacts: [{ fname: "Test", lname: "Customer", phones: [{ phone: "(555) 010-0100" }] }],
  locations: [{ city: "Springfield", state_prov: "IN" }],
};

describe("filterFields", () => {
  it("keeps only allowed top-level fields", () => {
    const out = filterFields(customer, ["id", "customer_name"]) as Record<string, Json>;
    expect(out).toEqual({ id: 1001, customer_name: "Test Customer" });
  });

  it("drops financial fields a tech may not see", () => {
    const out = filterFields(customer, ["id", "customer_name", "locations.*"]) as Record<string, Json>;
    expect(out.account_balance).toBeUndefined();
    expect(out.credit_rating).toBeUndefined();
    expect(out.private_notes).toBeUndefined();
  });

  it("descends into arrays without consuming a path segment", () => {
    const out = filterFields(customer, ["contacts.phones.*"]) as Record<string, Json>;
    expect(out).toEqual({ contacts: [{ phones: [{ phone: "(555) 010-0100" }] }] });
  });

  it("prunes sibling keys inside an array element", () => {
    const out = filterFields(customer, ["contacts.fname"]) as Record<string, Json>;
    expect(out).toEqual({ contacts: [{ fname: "Test" }] });
  });

  it("returns the value unchanged for allow ['*']", () => {
    expect(filterFields(customer, ["*"])).toEqual(customer);
  });

  it("returns an empty object when nothing is allowed", () => {
    expect(filterFields(customer, ["nonexistent_field"])).toEqual({});
  });

  it("filters every element of a list response", () => {
    const list: Json = [{ id: 1, account_balance: 9 }, { id: 2, account_balance: 8 }];
    expect(filterFields(list, ["id"])).toEqual([{ id: 1 }, { id: 2 }]);
  });

  // --- Adversarial cases beyond the brief ---

  it("does not let a key that is a textual prefix of an allowed pattern leak", () => {
    // "contact" (singular) is a string-prefix of the pattern "contacts.fname"
    // but is not itself allowed and must not slip through the dot-boundary check.
    const data = JSON.parse(
      '{"contact": {"account_balance": 999}, "contacts": [{"fname": "Test", "lname": "Customer"}]}'
    ) as Json;
    expect(filterFields(data, ["contacts.fname"])).toEqual({ contacts: [{ fname: "Test" }] });
  });

  it("drops a vendor key literally named __proto__ unconditionally, even when directly allow-listed", () => {
    // JSON.parse legitimately produces an own-enumerable "__proto__" key, which
    // Object.entries will iterate. No legitimate allowlist can ever name a
    // real field "__proto__", so it must never survive into the output —
    // not even preserved as a normal own property (which is safe by itself
    // but still a poisoned-but-inert key that would re-trigger the original
    // corruption in any downstream consumer that copies the result with
    // Object.assign({}, filtered) or a for..of Object.keys loop).
    const malicious = JSON.parse(
      '{"__proto__": {"account_balance": 99999}, "id": 1, "secret": "no"}'
    ) as Json;

    // "__proto__" is directly allowlisted here — must still be dropped.
    const out = filterFields(malicious, ["id", "__proto__"]) as Record<string, Json>;

    expect(out).toEqual({ id: 1 });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(false);
    // Must not be reachable via the prototype chain either — this is what
    // actually distinguishes "dropped" from "relocated but still present".
    expect((out as unknown as Record<string, unknown>).account_balance).toBeUndefined();
  });

  it("drops a vendor key literally named __proto__ even when only a nested pattern targets it", () => {
    // Same hazard, reached through the recursive-descent branch instead of
    // the whole-subtree-selected branch.
    const malicious = JSON.parse(
      '{"__proto__": {"account_balance": 99999, "other": "drop me"}}'
    ) as Json;

    const out = filterFields(malicious, ["__proto__.account_balance"]) as Record<string, Json>;

    expect(out).toEqual({});
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(false);
    expect((out as unknown as Record<string, unknown>).account_balance).toBeUndefined();
  });

  it("does not let a vendor key containing a literal dot be split into path segments (wildcard pattern)", () => {
    // CRITICAL: a vendor key literally named "locations.internal_credit_memo"
    // must be treated as one opaque segment, never as ["locations",
    // "internal_credit_memo"]. If it were split, allow: ["locations.*"]
    // would wrongly select its entire (unrelated, financial) subtree.
    const data = JSON.parse(
      '{"locations":[{"city":"Springfield"}],' +
        '"locations.internal_credit_memo":{"account_balance":4200,"private_notes":"slow payer"}}'
    ) as Json;

    const out = filterFields(data, ["locations.*"]);

    expect(out).toEqual({ locations: [{ city: "Springfield" }] });
    expect((out as Record<string, Json>)["locations.internal_credit_memo"]).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("account_balance");
    expect(JSON.stringify(out)).not.toContain("private_notes");
  });

  it("does not let a vendor key containing a literal dot match a same-spelled exact pattern", () => {
    // CRITICAL, worse variant: an exact pattern match selects its whole
    // subtree unpruned, so if "contacts.fname" (the pattern) were compared
    // as a raw string against a top-level key literally named
    // "contacts.fname", the entire unrelated subtree would come back intact.
    const data = JSON.parse('{"contacts.fname":{"account_balance":4200,"ssn":"123"}}') as Json;

    expect(filterFields(data, ["contacts.fname"])).toEqual({});
  });

  it("still matches a genuinely nested field addressed by an exact multi-segment pattern", () => {
    // Companion to the two CRITICAL cases above: the fix must not
    // over-reject real nesting just because it now compares segments
    // instead of strings.
    const data: Json = { locations: [{ city: "Springfield", state_prov: "IN" }] };
    expect(filterFields(data, ["locations.city"])).toEqual({ locations: [{ city: "Springfield" }] });
  });

  it("preserves an explicit null value for an allowed field instead of dropping it", () => {
    const data: Json = { id: 1, credit_rating: null, account_balance: 500 };
    expect(filterFields(data, ["id", "credit_rating"])).toEqual({ id: 1, credit_rating: null });
  });

  it("drops (rather than leaks through) keys whose value is an empty array or empty object", () => {
    // Nothing inside an empty container can match a nested pattern, so the
    // parent key itself must disappear rather than surface as `[]` or `{}`
    // noise — deny-by-default fails toward absence, never toward a surprising
    // empty placeholder that a caller might mistake for "field exists, has no data".
    const data: Json = { id: 1, contacts: [], meta: {} };
    expect(filterFields(data, ["id", "contacts.fname", "meta.anything"])).toEqual({ id: 1 });
  });

  // --- Finding 4 (round 2): __proto__ must not survive a whole-subtree grant ---

  it("sanitizes a __proto__ key nested inside a wildcard whole-subtree grant", () => {
    // The whole-subtree-grant branch pushes the matched value wholesale
    // instead of walking it key-by-key, so the per-key "__proto__" skip
    // elsewhere in the walk never runs for anything nested inside it. This
    // is the canonical shape: "locations.*" is exactly the pattern Task 12's
    // real roles.json ships, and a vendor element under it can carry its own
    // "__proto__" key.
    const data = JSON.parse(
      '{"locations":[{"city":"Springfield","__proto__":{"account_balance":4200}}]}'
    ) as Json;

    const out = filterFields(data, ["locations.*"]) as Record<string, Json>;
    const element = (out.locations as Json[])[0] as Record<string, Json>;

    expect(Object.keys(element)).toEqual(["city"]);
    expect(Object.prototype.hasOwnProperty.call(element, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(element)).toBe(Object.prototype);

    // The exploit as the reviewer phrased it: a completely ordinary
    // downstream copy must not pick up the dropped field via the prototype
    // chain.
    const copy = Object.assign({}, element);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect((copy as unknown as Record<string, unknown>).account_balance).toBeUndefined();
  });

  it("an exact (non-wildcard) pattern matching an object-shaped path grants nothing under it, __proto__ included (B1)", () => {
    // Post-B1: only a wildcard allow entry ("*" or a trailing ".*") grants a
    // whole subtree. A bare exact pattern like "contacts" names one field,
    // not "contacts and everything nested under it" — so once the upstream
    // value at that path is an object rather than a primitive, nothing
    // beneath it is granted unless some OTHER allow entry names it
    // explicitly. The __proto__ hazard this test originally guarded against
    // (a poisoned key surviving a whole-subtree copy) is moot under the new
    // behavior: there is no whole-subtree copy for an exact pattern to make
    // in the first place — the entire drifted object is denied, which is
    // strictly safer.
    const data = JSON.parse(
      '{"contacts":{"fname":"Test","__proto__":{"account_balance":999}}}'
    ) as Json;

    const out = filterFields(data, ["contacts"]) as Record<string, Json>;
    expect(out).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(out, "contacts")).toBe(false);
  });

  it("a wildcard pattern still returns a normal nested subtree complete (control, B1)", () => {
    // Companion to the exact-pattern case above: a genuine subtree grant —
    // written as "contacts.*" — still returns the whole thing untouched
    // (modulo the __proto__ sanitize pass, already covered by the
    // "locations.*" test above). This is the "did the fix over-correct and
    // break legitimate wildcard grants" control.
    const data: Json = {
      contacts: { fname: "Test", lname: "Customer", phones: [{ phone: "(555) 010-0100" }] },
    };
    expect(filterFields(data, ["contacts.*"])).toEqual(data);
  });

  it("an exact pattern naming an object-shaped field still surfaces it once a matching leaf is also named explicitly (control, B1)", () => {
    // Proves the fix doesn't over-reject: "contacts" alone grants nothing
    // nested, but adding the specific leaf pattern still works exactly like
    // any other multi-segment exact pattern.
    const data: Json = { contacts: { fname: "Test", lname: "Customer" } };
    expect(filterFields(data, ["contacts.fname"])).toEqual({ contacts: { fname: "Test" } });
  });

  // --- B1 (Task 12 final review): upstream schema drift must fail closed ---

  it("fails closed when an upstream field drifts from a primitive to an object, even for the real bookkeeper allowlist (B1)", () => {
    // bookkeeper's real, committed invoice_*.allow includes the bare
    // (non-wildcard) entries "customer" and "terms". Today Service Fusion
    // returns "customer" as a plain string; if it ever becomes an object
    // (or a config author adds `"query": {"expand": "customer"}` to
    // invoice_list, which is the natural next edit given the vendor's
    // `?expand=` model), account_balance/credit_rating/private_notes must
    // never come through just because "customer" is a name on the allowlist.
    const bookkeeperInvoiceAllow = [
      "id", "number", "total", "is_paid", "date", "po_number", "terms", "customer",
    ];
    const invoice: Json = {
      id: 501,
      number: "INV-501",
      total: 1200,
      is_paid: false,
      date: "2026-09-01",
      po_number: "PO-9",
      terms: "net_30",
      customer: {
        id: 1001,
        customer_name: "Acme Plumbing",
        account_balance: 4200,
        credit_rating: "B",
        private_notes: "slow payer",
      },
    };

    const out = filterFields(invoice, bookkeeperInvoiceAllow) as Record<string, Json>;

    expect(JSON.stringify(out)).not.toContain("account_balance");
    expect(JSON.stringify(out)).not.toContain("credit_rating");
    expect(JSON.stringify(out)).not.toContain("private_notes");
    // The rest of the row must still come through normally — this is a
    // fail-closed fix, not a "drop the whole row" regression.
    expect(out).toEqual({
      id: 501, number: "INV-501", total: 1200, is_paid: false,
      date: "2026-09-01", po_number: "PO-9", terms: "net_30",
    });
  });
});
