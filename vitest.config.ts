import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // `.next` must be excluded explicitly — vitest's default `exclude` covers
    // node_modules and dist, but not the Next build directory. Since
    // `output: "standalone"` was added for Cloud Run, `next build` copies
    // `orgs/**` into `.next/standalone/` verbatim, test file included. Without
    // this, running the suite after a build collects
    // `.next/standalone/orgs/orgs.test.ts` as well as the real
    // `orgs/orgs.test.ts` and silently runs the wildcard config lint twice —
    // once against a stale snapshot of the config, whose failures would point
    // at a file nobody edits.
    exclude: ["**/node_modules/**", "**/.next/**"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // `server-only` throws when imported outside the "react-server" export
      // condition, which vitest does not set. Alias it to the package's own
      // no-op "react-server" build instead of setting that condition globally
      // (which would also flip React itself to its react-server builds).
      // The target must be an absolute filesystem path, not the bare
      // specifier "server-only/empty.js": that subpath isn't listed in the
      // package's "exports" map, so Vite's resolver (which enforces
      // "exports") would reject it before the alias substitution helps.
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url)
      ),
    },
  },
});
