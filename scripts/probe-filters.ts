/**
 * npm run probe-filters -- <org>/<app> [<org>/<app> ...]
 *
 * Checks every filter a connector declares against the live upstream, read-only. For each
 * GET list tool, it fetches an unfiltered baseline, then sends each templated query
 * parameter alone with a value that should match nothing, and compares the counts:
 *
 *   ok        the count dropped: the upstream applied the filter.
 *   IGNORED?  the count did not move: the upstream may be dropping an unknown parameter
 *             (FieldEdge does this silently), so the tool would return unfiltered data
 *             that looks filtered.
 *   REJECTED  4xx: either the name is wrong (Service Fusion 400s on an unknown filter
 *             property) or the probe's value is in the wrong format. The message says
 *             which; if it is the format, make sure the tool's description states it.
 *
 * It also prints any rate-limit headers on the baseline response. If the upstream sends a
 * quota countdown, declare it as `transport.rateLimit` in api.json.
 *
 * Why this exists: a third-party Service Fusion connector we reviewed (2026-10-12) sent
 * `filters[customer_name]` (the filter is `name`) and `filters[customer_id]` (no such
 * filter), so its customer search 400'd on every call. The same audit run against our own
 * catalogs found every filter name valid, plus one silent-empty case (calendar_task_list
 * returns nothing given only one bound of its period filter). This command is how to keep
 * it that way when onboarding or extending a connector.
 *
 * Tools whose path needs an argument, POST searches, enum-valued parameters, and tools
 * whose unfiltered baseline fails (usually because they declare required inputs) are
 * skipped or reported, not probed. Paced at 1.5x the app's minIntervalMs.
 */

import { register } from "node:module";
import process from "node:process";

const REPO_ROOT = new URL("../", import.meta.url).href;

// Must run before any "@/..." or extension-omitted local module is touched —
// see the file header. Everything after this point that needs such a module
// uses a dynamic import(), never a static one: static imports in this file
// would already have been resolved (and would already have failed) before
// this line ever executed.
register(
  `data:text/javascript,${encodeURIComponent(`
    const ROOT = ${JSON.stringify(REPO_ROOT)};
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === "server-only") {
        return { url: "data:text/javascript,export default {}", shortCircuit: true };
      }
      const spec = specifier.startsWith("@/")
        ? new URL(specifier.slice(2), ROOT).href
        : specifier;
      try {
        return await nextResolve(spec, context);
      } catch (err) {
        const isLocal = spec.startsWith(".") || spec.startsWith("file://");
        const hasExt = /\\.[a-zA-Z0-9]+$/.test(spec);
        if (isLocal && !hasExt && err && err.code === "ERR_MODULE_NOT_FOUND") {
          return await nextResolve(spec + ".ts", context);
        }
        throw err;
      }
    }
  `)}`,
  import.meta.url,
);

const SKIP = new Set(["fields", "expand", "sort", "orderBy", "select", "include"]);
const QUOTA_HEADER = /rate.?limit|retry-after|quota/i;

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = (o: Json, path?: string): Json => (path ? path.split(".").reduce((a: Json, k) => a?.[k], o) : undefined);

/** A value that should match nothing, in the format the parameter's description asks for. */
function noMatchValues(queryKey: string, schema: Json): string[] | null {
  if (schema?.enum) return null;
  if (schema?.type === "boolean") return ["true", "false"];
  if (schema?.type === "integer" || schema?.type === "number") return ["999999999"];
  const desc = String(schema?.description ?? "");
  // Strip the `filters[...]` wrapper first: "filters" itself contains "lte".
  const key = queryKey.toLowerCase().replace(/^filters/, "");
  const bound = key.match(/\[(lte|gte)\]$/)?.[1];
  const upper = bound ? bound === "lte" : /end|before|until|max|\bto\b/.test(key);
  if (/datetime|rfc 3339|iso 8601/i.test(desc)) return [upper ? "1970-01-02T00:00:00Z" : "2999-01-01T00:00:00Z"];
  if (/yyyy-mm-dd|date/i.test(desc) || /date|after|before/.test(key)) return [upper ? "1970-01-02" : "2999-01-01"];
  if (/10 digits|phone/i.test(desc + key)) return ["5555550199"];
  if (/email/i.test(desc + key)) return ["zzqx@nomatch.invalid"];
  if (/guid/i.test(desc) || /id\]?$/.test(key)) return ["00000000-0000-0000-0000-000000000000"];
  return ["zzqxnomatch"];
}

async function main() {
  const keys = process.argv.slice(2);
  if (!keys.length) {
    console.error("usage: npm run probe-filters -- <org>/<app> [<org>/<app> ...]");
    process.exit(1);
  }
  const { getCatalog } = await import("../lib/mcp/catalog");
  const { vaultFetcher } = await import("../lib/secrets/vault");
  const { getUpstreamToken } = await import("../lib/adapters/auth");
  const secret = async (path: string) => {
    const v = await vaultFetcher(path);
    if (!v) throw new Error(`no Vault secret at ${path}`);
    return v;
  };

  for (const key of keys) {
    const entry = getCatalog().get(key);
    if (!entry) throw new Error(`no app ${key} in the catalog`);
    const cfg = entry.config;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await getUpstreamToken(entry, { secret, config: cfg } as never)}`,
      Accept: "application/json",
    };
    for (const [name, path] of Object.entries(cfg.requestHeaders ?? {})) headers[name] = await secret(path);
    const gap = Math.max(cfg.transport.minIntervalMs * 1.5, 300);
    let quotaShown = false;

    const call = async (path: string, query: Record<string, string>) => {
      await sleep(gap);
      const url = new URL(cfg.baseUrl + path);
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000), redirect: "manual" });
        const text = await res.text();
        let body: Json;
        try { body = JSON.parse(text); } catch { body = undefined; }
        if (!quotaShown && res.ok) {
          quotaShown = true;
          const quota: string[] = [];
          res.headers.forEach((v, h) => { if (QUOTA_HEADER.test(h)) quota.push(`${h}=${v}`); });
          console.log(`  rate-limit headers: ${quota.length ? quota.join(", ") : "none"}`
            + (cfg.transport.rateLimit ? "  (transport.rateLimit declared)" : ""));
        }
        return { status: res.status, body, text };
      } catch (err) {
        return { status: 0, body: undefined, text: `no response: ${(err as Error).name}` };
      }
    };

    console.log(`\n${key}  ${cfg.baseUrl}`);
    for (const tool of cfg.tools as Json[]) {
      const req = tool.request;
      if (!req || req.method !== "GET" || req.path.includes("{{") || !req.query) continue;
      const entries = Object.entries(req.query as Record<string, string>);
      const fixed = Object.fromEntries(entries.filter(([, v]) => !v.includes("{{")));
      const probed = entries.filter(([k, v]) => v.includes("{{") && !SKIP.has(k));
      if (!probed.length) continue;
      const required: string[] = tool.input?.required ?? [];
      if (required.length) {
        console.log(`  ${tool.name}: requires ${required.join(", ")}, not probed`);
        continue;
      }
      const count = (b: Json): number | undefined => {
        const total = at(b, tool.list?.pagination?.totalCountAt);
        if (typeof total === "number") return total;
        const items = tool.list?.itemsAt ? at(b, tool.list.itemsAt) : b;
        return Array.isArray(items) ? items.length : undefined;
      };

      const base = await call(req.path, fixed);
      const baseline = count(base.body);
      if (base.status >= 400 || base.status === 0 || baseline === undefined) {
        console.log(`  ${tool.name}: baseline ${base.status || "failed"}, not probed (${base.text.replace(/\s+/g, " ").slice(0, 100)})`);
        continue;
      }
      console.log(`  ${tool.name}  ${req.path}  baseline n=${baseline}${tool.list?.pagination?.totalCountAt ? "" : " (one page; no total)"}`);
      for (const [queryKey, template] of probed) {
        const arg = template.match(/\{\{(\w+)\}\}/)?.[1] ?? "";
        const values = noMatchValues(queryKey, tool.input?.properties?.[arg]);
        if (!values) { console.log(`    skipped   ${queryKey} (enum)`); continue; }
        const results = [];
        for (const v of values) {
          const r = await call(req.path, { ...fixed, [queryKey]: v });
          results.push({ v, status: r.status, n: r.status >= 200 && r.status < 300 ? count(r.body) : undefined, text: r.text });
        }
        const verdict = results.some((r) => r.n === undefined) ? "REJECTED"
          : baseline > 0 && results.every((r) => r.n === baseline) ? "IGNORED?" : "ok";
        const detail = results.map((r) => r.n === undefined
          ? `${r.v} -> ${r.status} ${r.text.replace(/\s+/g, " ").slice(0, 140)}`
          : `${r.v} -> n=${r.n}`).join(" | ");
        console.log(`    ${verdict.padEnd(9)} ${queryKey}  ${detail}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
