import { describe, it, expect } from "vitest";
import { writableFieldProblems } from "@/lib/policy/write-policy";
import type { Json } from "@/lib/types";

describe("writableFieldProblems", () => {
  it("permits a write where every key is scalar and allowlisted (empty array = permitted)", () => {
    const fields: Json = { email: "a@example.com", age: 40, is_active: true, notes: null };
    expect(writableFieldProblems(fields, ["email", "age", "is_active", "notes"])).toEqual([]);
  });

  // --- Deny-by-default ---

  it("reports a key not present in the allowlist", () => {
    expect(writableFieldProblems({ email: "a@example.com" }, [])).toEqual([
      'field "email" is not writable',
    ]);
  });

  it("an empty allow array denies every field", () => {
    const fields: Json = { a: 1, b: 2 };
    expect(writableFieldProblems(fields, [])).toEqual([
      'field "a" is not writable',
      'field "b" is not writable',
    ]);
  });

  it("allows only the fields named, denying the rest", () => {
    const fields: Json = { email: "a@example.com", ssn: "123-45-6789" };
    expect(writableFieldProblems(fields, ["email"])).toEqual(['field "ssn" is not writable']);
  });

  // --- No wildcards, ever ---

  it("treats a bare '*' allow entry as a problem and grants nothing", () => {
    const fields: Json = { email: "a@example.com" };
    expect(writableFieldProblems(fields, ["*"])).toEqual([
      'allowlist entry "*" is not a literal field name — write allowlists must name every writable field',
      'field "email" is not writable',
    ]);
  });

  it("treats a trailing '.*' allow entry as a problem and grants nothing, even for an exact-looking key", () => {
    const fields: Json = { email: "a@example.com" };
    expect(writableFieldProblems(fields, ["email.*"])).toEqual([
      'allowlist entry "email.*" is not a literal field name — write allowlists must name every writable field',
      'field "email" is not writable',
    ]);
  });

  it("reports a wildcard-shaped allow entry as a problem even when fields is otherwise empty", () => {
    expect(writableFieldProblems({}, ["contacts.*"])).toEqual([
      'allowlist entry "contacts.*" is not a literal field name — write allowlists must name every writable field',
    ]);
  });

  it("matches nested leaf paths literally, with no wildcard semantics", () => {
    const fields: Json = { "contacts.fname": "Test", contacts: { fname: "Test" } };
    expect(writableFieldProblems(fields, ["contacts.fname"])).toEqual([
      'field "contacts.fname" is not writable',
    ]);
  });

  // --- fields must be a non-null, non-array object ---

  it.each([
    ["a string", "not an object"],
    ["a number", 42],
    ["a boolean", true],
    ["null", null],
    ["an array", [1, 2, 3]],
  ])("reports a problem when fields is %s instead of an object", (_label, value) => {
    expect(writableFieldProblems(value as Json, ["a"])).toEqual(["fields must be an object"]);
  });

  // --- Own properties only ---

  it("treats keys spelling Object.prototype members as ordinary keys, checked against the allowlist", () => {
    const fields = JSON.parse(
      '{"toString": "x", "constructor": 1, "hasOwnProperty": true, "valueOf": null}',
    ) as Json;
    // All four are explicitly allowlisted and all four values are scalar,
    // so this must come back clean -- proving these keys are read as real
    // own properties (via Object.entries) rather than silently resolving
    // through the prototype chain to something that isn't actually in the
    // JSON at all.
    expect(
      writableFieldProblems(fields, ["toString", "constructor", "hasOwnProperty", "valueOf"]),
    ).toEqual([]);
  });

  it("denies a key spelling an Object.prototype member when it is not allowlisted", () => {
    const fields = JSON.parse('{"constructor": "hijack"}') as Json;
    expect(writableFieldProblems(fields, [])).toEqual(['field "constructor" is not writable']);
  });

  // --- __proto__ is always a problem ---

  it("denies a __proto__ key even when it is directly named in the allowlist", () => {
    const fields = JSON.parse('{"__proto__": {"account_balance": 99999}}') as Json;
    // "__proto__" is directly allowlisted here -- must still be denied.
    expect(writableFieldProblems(fields, ["__proto__"])).toEqual([
      'field "__proto__" is not writable',
    ]);
  });

  it("denies a __proto__ key alongside otherwise-permitted fields, without affecting the others", () => {
    const fields = JSON.parse('{"email": "a@example.com", "__proto__": {"x": 1}}') as Json;
    expect(writableFieldProblems(fields, ["email", "__proto__"])).toEqual([
      'field "__proto__" is not writable',
    ]);
  });

  // --- Nested structures use exact leaf paths ---

  it("reports a nested object leaf that is not allowlisted", () => {
    const fields: Json = { address: { city: "Springfield" } };
    expect(writableFieldProblems(fields, ["address"])).toEqual([
      'field "address.city" is not writable',
    ]);
  });

  it("normalizes array indices to [] and permits explicitly allowlisted leaves", () => {
    const fields: Json = {
      contacts: [{ fname: "Ada", phones: [{ phone: "555-0100" }] }],
    };
    expect(
      writableFieldProblems(fields, ["contacts[].fname", "contacts[].phones[].phone"]),
    ).toEqual([]);
  });

  it("reports a scalar array element unless its [] path is explicitly allowlisted", () => {
    const fields: Json = { tags: ["a", "b"] };
    expect(writableFieldProblems(fields, ["tags"])).toEqual([
      'field "tags[]" is not writable',
      'field "tags[]" is not writable',
    ]);
    expect(writableFieldProblems(fields, ["tags[]"])).toEqual([]);
  });

  it("rejects empty containers because they have no authorizable leaf", () => {
    expect(writableFieldProblems({ contacts: [] }, ["contacts[].fname"])).toEqual([
      'field "contacts" must not be an empty array',
    ]);
    expect(writableFieldProblems({ address: {} }, ["address.city"])).toEqual([
      'field "address" must not be an empty object',
    ]);
  });

  it("permits string, number, boolean, and null values", () => {
    const fields: Json = { s: "x", n: 1, b: false, z: null };
    expect(writableFieldProblems(fields, ["s", "n", "b", "z"])).toEqual([]);
  });

  // --- Every problem is reported, not just the first ---

  it("reports every problem across multiple bad fields in one pass", () => {
    const fields: Json = { unknown: "x", nested: { a: 1 }, ok: "fine" };
    expect(writableFieldProblems(fields, ["ok"])).toEqual([
      'field "unknown" is not writable',
      'field "nested.a" is not writable',
    ]);
  });

  it("reports an unallowlisted nested leaf", () => {
    const fields: Json = { secret: { leaked: true } };
    expect(writableFieldProblems(fields, [])).toEqual([
      'field "secret.leaked" is not writable',
    ]);
  });

  it("reports multiple wildcard-allowlist problems alongside field problems", () => {
    const fields: Json = { email: "a@example.com" };
    expect(writableFieldProblems(fields, ["*", "phones.*"])).toEqual([
      'allowlist entry "*" is not a literal field name — write allowlists must name every writable field',
      'allowlist entry "phones.*" is not a literal field name — write allowlists must name every writable field',
      'field "email" is not writable',
    ]);
  });

  // --- NFC normalization ---

  it("matches an allow entry and a field key that are canonically equivalent but differently encoded", () => {
    // "café" written as a single precomposed "é" (NFC) vs. the same string
    // written as "e" + a combining acute accent (NFD). The two are visually
    // and semantically identical but not === as raw strings.
    const nfc = "café"; // precomposed é
    const nfd = "café"; // "e" + combining acute accent

    expect(nfc).not.toBe(nfd);
    expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));

    const fields: Json = { [nfd]: "some value" };
    expect(writableFieldProblems(fields, [nfc])).toEqual([]);
  });

  it("still denies a genuinely different key even after normalization", () => {
    const fields: Json = { "café": "value" }; // NFD café
    expect(writableFieldProblems(fields, ["tea"])).toEqual([
      'field "café" is not writable',
    ]);
  });
});
