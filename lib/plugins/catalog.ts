import "server-only";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { zipSync } from "fflate";

/**
 * Claude plugins under `plugins/` that org members can download from the home
 * page. Read off disk at request time, like `orgs/` — the Dockerfile copies the
 * directory into the runtime image for the same reason it copies `orgs/`.
 *
 * A plugin belongs to an org when its bundled `.mcp.json` points at that org's
 * gateway endpoint (`/mcp/<org>` or `/mcp/<org>/<app>`). That is the plugin's
 * one hard dependency on an org, so it is the membership rule too: nobody can
 * download a plugin whose connector they could not use.
 */

export interface PluginSummary {
  name: string;
  displayName: string;
  version: string;
  description: string;
}

/** Never shipped to a customer: eval suites and their recorded results. */
const EXCLUDED_DIRS = new Set(["evals"]);
const EXCLUDED_FILES = new Set([".DS_Store"]);

export function pluginsDir(): string {
  return join(process.cwd(), "plugins");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function orgsServedBy(mcpJson: unknown): Set<string> {
  const orgs = new Set<string>();
  const servers = (mcpJson as { mcpServers?: Record<string, { url?: unknown }> })?.mcpServers ?? {};
  for (const server of Object.values(servers)) {
    if (typeof server?.url !== "string") continue;
    let path: string;
    try {
      path = new URL(server.url).pathname;
    } catch {
      continue;
    }
    const m = /^\/mcp\/([^/]+)(?:\/[^/]+)?\/?$/.exec(path);
    if (m) orgs.add(m[1]);
  }
  return orgs;
}

/** Every plugin whose connector targets `orgSlug`, sorted by name. */
export function listPluginsForOrg(orgSlug: string, root = pluginsDir()): PluginSummary[] {
  if (!existsSync(root)) return [];
  const plugins: PluginSummary[] = [];
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    const manifestPath = join(dir, ".claude-plugin", "plugin.json");
    const mcpPath = join(dir, ".mcp.json");
    if (!existsSync(manifestPath) || !existsSync(mcpPath)) continue;
    if (!orgsServedBy(readJson(mcpPath)).has(orgSlug)) continue;
    const manifest = readJson(manifestPath) as Partial<PluginSummary>;
    // The manifest name is what claude.ai installs under; a mismatch with the
    // directory would make the download URL and the installed plugin disagree.
    if (manifest.name !== name) continue;
    plugins.push({
      name,
      displayName: manifest.displayName ?? name,
      version: manifest.version ?? "0.0.0",
      description: manifest.description ?? "",
    });
  }
  return plugins;
}

function collect(dir: string, root: string, out: Record<string, Uint8Array>): void {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry)) collect(path, root, out);
    } else if (!EXCLUDED_FILES.has(entry)) {
      out[relative(root, path).split(sep).join("/")] = readFileSync(path);
    }
  }
}

/**
 * Zips one plugin for `orgSlug`, or returns null when that org has no plugin
 * by that name. Resolving the name through `listPluginsForOrg` rather than
 * joining it onto a path is what keeps a crafted name from reading outside
 * `plugins/`.
 */
export function zipPluginForOrg(
  orgSlug: string,
  name: string,
  root = pluginsDir(),
): { summary: PluginSummary; zip: Uint8Array } | null {
  const summary = listPluginsForOrg(orgSlug, root).find((p) => p.name === name);
  if (!summary) return null;
  const files: Record<string, Uint8Array> = {};
  const dir = join(root, summary.name);
  collect(dir, dir, files);
  return { summary, zip: zipSync(files, { level: 9 }) };
}
