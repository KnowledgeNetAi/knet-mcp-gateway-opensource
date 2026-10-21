import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { scrubErrorDetail } from "@/lib/mcp/handler";

describe("scrubErrorDetail", () => {
  it("drops query strings, which are built from caller arguments", () => {
    const out = scrubErrorDetail("https://up.test/people?name=Ada&dob=1815 -> HTTP 404: not found", {}, []);
    expect(out).not.toContain("Ada");
    expect(out).toContain("HTTP 404");
  });

  it("removes a redacted value wherever it was interpolated, including encoded in a path", () => {
    const out = scrubErrorDetail(
      "https://up.test/people/078-05-1120%2B -> HTTP 500: record 078-05-1120+ failed",
      { ssn: "078-05-1120+" },
      ["ssn"],
    );
    expect(out).not.toContain("078-05-1120");
    expect(out).toContain("[redacted]");
  });

  it("caps the stored length", () => {
    expect(scrubErrorDetail("x".repeat(10_000), {}, []).length).toBeLessThanOrEqual(2000);
  });

  it("survives absurdly deep arguments instead of costing the audit row", () => {
    let deep: unknown = "secret-value";
    for (let i = 0; i < 100_000; i++) deep = { a: deep };
    expect(() => scrubErrorDetail("upstream failed", { a: deep } as never, ["a"])).not.toThrow();
  });
});
