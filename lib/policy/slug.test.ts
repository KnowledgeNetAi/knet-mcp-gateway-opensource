import { describe, it, expect } from "vitest";
import { isValidOrgSlug, ORG_SLUG_CHARS } from "@/lib/policy/slug";

describe("org slug", () => {
  it("accepts the charset generateApiKey produces", () => {
    expect(isValidOrgSlug("contoso")).toBe(true);
    expect(isValidOrgSlug("acme-co-2")).toBe(true);
  });

  it("rejects anything outside it", () => {
    for (const bad of ["", "Acme", "acme_co", "acme co", "acme/co", "acme.co"]) {
      expect(isValidOrgSlug(bad)).toBe(false);
    }
  });

  // RegExp.prototype.test coerces its argument, so "null"/"undefined" would
  // match the charset if the type guard were dropped. This is the phase 1
  // reasoning in api-key.ts, preserved through the extraction.
  it("rejects non-strings without coercing them", () => {
    for (const bad of [null, undefined, 123, {}, []]) {
      expect(isValidOrgSlug(bad)).toBe(false);
    }
  });

  it("exposes a charset safe to splice into a character class", () => {
    expect(ORG_SLUG_CHARS).not.toMatch(/[\]\\^]/);
  });
});
