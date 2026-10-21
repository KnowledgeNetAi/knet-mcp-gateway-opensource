import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/http/safe-next";

describe("safeNextPath", () => {
  it("keeps a same-origin path with its query", () => {
    expect(safeNextPath("/oauth/authorize?client_id=x", "/")).toBe("/oauth/authorize?client_id=x");
    expect(safeNextPath("/admin", "/")).toBe("/admin");
  });

  it("refuses anything that could leave the origin", () => {
    for (const bad of [
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/%09/evil.example".replace("%09", "\t"),
      "https://evil.example",
      "evil.example",
      "javascript:alert(1)",
      "",
    ]) {
      expect(safeNextPath(bad, "/fallback"), JSON.stringify(bad)).toBe("/fallback");
    }
    expect(safeNextPath(null, "/fallback")).toBe("/fallback");
  });

  it("never returns a value a browser would resolve to another origin", () => {
    for (const candidate of ["/a", "/\t/x", "//x", "/./x", "/..//x"]) {
      const out = safeNextPath(candidate, "/");
      expect(new URL(out, "https://gw.example.com").origin).toBe("https://gw.example.com");
    }
  });
});
