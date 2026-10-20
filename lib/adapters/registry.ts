import type { Adapter, AppAdapter } from "./types";
import { adapter as demoHelloworld } from "@/orgs/demo/helloworld/adapter";

/**
 * Every adapter that runs in production, one line per app. Static imports on purpose — no
 * directory scan, no dynamic `import()` driven by config — so the complete set of code that
 * can execute against a customer's upstream is visible in review, here.
 *
 * `loadCatalog` refuses an `orgs/<org>/<app>/adapter.ts` that is missing from this map, and
 * `checkAdapterRegistry` refuses a key here that names no loaded app or an adapter tool that
 * names no tool in that app's api.json.
 */
export const ADAPTERS: Readonly<Record<string, AppAdapter>> = Object.freeze({
  "demo/helloworld": demoHelloworld,
});

const NONE: Adapter = Object.freeze({});

/**
 * The hooks for one tool, or none. Own-property lookups only: an org/app/tool name that
 * spells an `Object.prototype` member ("constructor", "toString") must resolve to nothing,
 * not to a function inherited through the prototype chain.
 */
export function adapterFor(
  org: string,
  app: string,
  tool: string,
  registry: Readonly<Record<string, AppAdapter>> = ADAPTERS,
): Adapter {
  const key = `${org}/${app}`;
  if (!Object.hasOwn(registry, key)) return NONE;
  const tools = registry[key].tools;
  return Object.hasOwn(tools, tool) ? tools[tool] : NONE;
}
