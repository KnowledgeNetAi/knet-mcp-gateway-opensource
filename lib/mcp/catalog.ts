import "server-only";
import { join } from "node:path";
import { loadCatalog, checkAdapterRegistry, ConfigError } from "@/lib/config/load";
import { checkToolInputSchema } from "@/lib/mcp/handler";
import type { AppEntry } from "@/lib/types";

// Loaded once per instance. A ConfigError here fails the build/boot rather than
// serving config a reviewer never saw.
let catalog: Map<string, AppEntry> | null = null;

// Task 11 fix round 1, minor item: a *failed* load must also be memoized, not just a
// successful one. Without this, every request arriving before the process is recycled would
// re-read and re-parse every org's config from disk (and re-run `checkToolInputSchema` over
// every tool) only to throw the same error again — a config error should be a stable,
// immediate 500, not a per-request filesystem/validation cost.
let bootError: Error | null = null;

export function getCatalog(): Map<string, AppEntry> {
  if (bootError) throw bootError;
  if (catalog) return catalog;

  try {
    // `loadCatalog` reads `orgs/**` off disk dynamically at runtime (readdirSync/readFileSync
    // in lib/config/load.ts), not via a static `import`/`require` Turbopack's file tracer can
    // see at build time by following module edges. Verified directly (Task 12 final review,
    // "ALSO FOLD IN"): Turbopack's production build DOES still include `orgs/**` in the
    // deployed Next.js lambda despite this — its tracer follows more than static imports for
    // files under the project root — so this dynamic read works today. Noted here so nobody
    // "optimizes" it later into a static import list (which would silently stop picking up a
    // newly onboarded org/app without a code change) on the mistaken assumption that a dynamic
    // filesystem read can't possibly be bundled correctly.
    const loaded = loadCatalog(join(process.cwd(), "orgs"));
    checkAdapterRegistry(loaded);

    // Task 11 fix round 1, finding I4: `lib/config/schema.ts` leaves `tool.input` as an
    // unvalidated free-form record, so a schema using a feature the MCP handler's
    // `validateArgs` doesn't understand (an unsupported top-level combinator, a `required`
    // name absent from `properties`) would otherwise load fine and only fail on a live
    // request — in the `required`-name case, permanently (the argument is simultaneously
    // "required" and "unknown", so no call can ever satisfy validation). Checked here so it
    // fails the boot instead, alongside every other config-shape check `loadCatalog` already
    // performs.
    for (const entry of loaded.values()) {
      for (const tool of entry.config.tools) {
        const problem = checkToolInputSchema(tool);
        if (problem) {
          throw new ConfigError(`orgs/${entry.org}/${entry.app}/api.json`, problem);
        }
      }
    }

    catalog = loaded;
    return catalog;
  } catch (e) {
    bootError = e instanceof Error ? e : new Error(String(e));
    throw bootError;
  }
}
