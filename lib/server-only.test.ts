import { describe, it, expect } from "vitest";

/**
 * `server-only` throws at import time unless resolved under the
 * "react-server" export condition. Vitest does not set that condition, so
 * without the alias in vitest.config.ts this import throws
 * "This module cannot be imported from a Client Component module."
 *
 * This test exists to catch a regression the moment any module (e.g. the
 * Supabase admin client added in a later task) does `import "server-only"` —
 * without the alias, every test that transitively imports such a module
 * fails at import time, not at assertion time.
 */
describe("server-only", () => {
  it("resolves under vitest without throwing", async () => {
    await expect(import("server-only")).resolves.toBeDefined();
  });
});
