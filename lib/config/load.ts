import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { appConfigSchema, rolesConfigSchema } from "./schema";
import { matchesToolPattern } from "@/lib/policy/paths";
import type { AppEntry } from "@/lib/types";
import type { AppAdapter } from "@/lib/adapters/types";
import { ADAPTERS } from "@/lib/adapters/registry";
import { authSecrets } from "@/lib/adapters/auth";

export class ConfigError extends Error {
  constructor(where: string, detail: string) {
    super(`${where}: ${detail}`);
    this.name = "ConfigError";
  }
}

function dirs(p: string): string[] {
  if (!existsSync(p)) return [];
  return readdirSync(p).filter((d) => statSync(join(p, d)).isDirectory());
}

function expand(patterns: string[], names: string[], where: string, roleName: string): string[] {
  const out = new Set<string>();
  for (const p of patterns) {
    if (p.endsWith("*")) {
      // Shared with grants.ts's runtime access-control matching (via
      // matchesToolPattern in lib/policy/paths.ts) so boot-time validation
      // and the actual grant computation can never drift on what a tool
      // pattern matches.
      const matches = names.filter((n) => matchesToolPattern(n, p));
      // A wildcard matching nothing is the same failure as an exact name
      // referencing a removed tool -- and worse to leave silent, since a
      // typo'd prefix ("custmer_*") reads as a working grant that quietly
      // grants nothing.
      if (matches.length === 0) {
        throw new ConfigError(where, `role "${roleName}" tool pattern "${p}" matches no tool`);
      }
      matches.forEach((n) => out.add(n));
    } else if (names.includes(p)) {
      out.add(p);
    } else {
      out.add(p); // kept so cross-validation can report it as unknown
    }
  }
  return [...out];
}

/**
 * Load every orgs/<org>/<app>/ into an in-memory catalog.
 * Throws ConfigError on anything a reviewer should have caught — the caller is
 * the boot path, so a throw here fails the build rather than serving bad config.
 */
export function loadCatalog(
  rootDir: string,
  adapters: Readonly<Record<string, AppAdapter>> = ADAPTERS,
): Map<string, AppEntry> {
  const catalog = new Map<string, AppEntry>();

  for (const org of dirs(rootDir)) {
    for (const app of dirs(join(rootDir, org))) {
      const dir = join(rootDir, org, app);
      const where = `orgs/${org}/${app}`;

      // An adapter.ts runs only if lib/adapters/registry.ts imports it. A committed file that
      // nothing imports would read as working code and run nothing, so it fails the build.
      const key = `${org}/${app}`;
      const registered = Object.hasOwn(adapters, key);
      const hasAdapterFile = existsSync(join(dir, "adapter.ts"));
      if (hasAdapterFile && !registered) {
        throw new ConfigError(
          where,
          `adapter.ts is present but "${key}" is not registered in lib/adapters/registry.ts`,
        );
      }
      if (registered && !hasAdapterFile) {
        throw new ConfigError(where, `"${key}" is registered in lib/adapters/registry.ts but has no adapter.ts`);
      }
      // Code under orgs/ runs only through adapter.ts. Any other code file (hooks.ts,
      // adapter.js, a helper) would read as working code and run nothing — or be imported by
      // adapter.ts and escape the one-file review boundary — so it fails the build. Tests are
      // the exception.
      for (const f of readdirSync(dir)) {
        if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f) && f !== "adapter.ts" && !/\.test\.ts$/.test(f)) {
          throw new ConfigError(where, `unexpected code file "${f}" — app code lives in adapter.ts only`);
        }
      }
      if (dirs(dir).length > 0) {
        throw new ConfigError(where, `unexpected subdirectory "${dirs(dir)[0]}" — an app directory holds config, adapter.ts and tests only`);
      }

      const parsed = appConfigSchema.safeParse(read(join(dir, "api.json"), where, "api.json"));
      if (!parsed.success) throw new ConfigError(`${where}/api.json`, parsed.error.message);
      const config = parsed.data;

      if (config.app !== app) {
        throw new ConfigError(where, `directory is "${app}" but api.json declares app "${config.app}"`);
      }

      // "ALSO FOLD IN" (Task 12 final review): `lib/config/schema.ts` types `auth.secrets` as
      // `z.record(z.string(), z.string())` — any string value is schema-valid, including one
      // that names a DIFFERENT tenant's Vault secret. `vaultFetcher` (lib/secrets/vault.ts)
      // trusts this path verbatim; a copy-pasted `api.json` with a half-updated
      // `client_secret` path (e.g. left pointing at another org's credential while everything
      // else was correctly renamed) would silently authenticate this app's calls with that
      // other tenant's Service Fusion client. The convention every committed secret path
      // already follows (`"<org>/<app>/<key>"` — see this app's own `auth.secrets`) is
      // enforced here, not as a zod `.refine()` on the schema itself: `org`/`app` are only
      // known once `loadCatalog` has walked the directory tree, not inside `appConfigSchema`,
      // which parses one `api.json` in isolation.
      const expectedSecretPrefix = `${org}/${app}/`;
      for (const [key, path] of Object.entries(authSecrets(config))) {
        if (!path.startsWith(expectedSecretPrefix)) {
          throw new ConfigError(
            where,
            `auth.secrets.${key} = ${JSON.stringify(path)} does not start with "${expectedSecretPrefix}" — a Vault secret path must belong to this org/app`,
          );
        }
      }
      for (const [header, path] of Object.entries(config.requestHeaders ?? {})) {
        if (!path.startsWith(expectedSecretPrefix)) {
          throw new ConfigError(
            where,
            `requestHeaders.${header} = ${JSON.stringify(path)} does not start with "${expectedSecretPrefix}" — a Vault secret path must belong to this org/app`,
          );
        }
      }

      const rolesParsed = rolesConfigSchema.safeParse(read(join(dir, "roles.json"), where, "roles.json"));
      if (!rolesParsed.success) throw new ConfigError(`${where}/roles.json`, rolesParsed.error.message);
      const roles = rolesParsed.data;

      // git -> git inconsistency fails the build (spec, "The git/DB seam").
      const toolNames = config.tools.map((t) => t.name);
      for (const [roleName, role] of Object.entries(roles.roles)) {
        for (const granted of expand(role.tools, toolNames, where, roleName)) {
          if (!toolNames.includes(granted)) {
            throw new ConfigError(where, `role "${roleName}" grants unknown tool "${granted}"`);
          }
        }
      }

      // A role granting a write tool with no matching `writes` allowlist can
      // reach the tool and write nothing — the same "reads as a working grant
      // but grants nothing" failure the wildcard check above rejects, except
      // here it fails at the customer's first attempted write rather than
      // visibly. Deny-by-default is the right RUNTIME answer (and the handler
      // enforces exactly that); it is the wrong thing to discover from
      // committed config, so it fails the build instead.
      const writeToolNames = new Set(config.tools.filter((t) => t.write).map((t) => t.name));
      for (const [roleName, role] of Object.entries(roles.roles)) {
        const covered = new Set<string>();
        for (const pattern of Object.keys(role.writes ?? {})) {
          for (const name of writeToolNames) {
            if (matchesToolPattern(name, pattern)) covered.add(name);
          }
        }
        for (const granted of expand(role.tools, toolNames, where, roleName)) {
          if (writeToolNames.has(granted) && !covered.has(granted)) {
            throw new ConfigError(
              where,
              `role "${roleName}" grants write tool "${granted}" but declares no "writes" ` +
                `allowlist covering it — that role could call the tool and write nothing. ` +
                `Name the writable fields, or drop the tool from this role.`,
            );
          }
        }
      }

      // Adapter tools must name real tools, and a tool's entry point must be unambiguous: a
      // tool with no `request` runs only through a registered `compose`, and a tool with a
      // `compose` declares no `request`/`list` (runTool would refuse it at call time; this
      // moves that failure to the build).
      const appAdapter = registered ? adapters[key] : undefined;
      for (const name of Object.keys(appAdapter?.tools ?? {})) {
        if (!toolNames.includes(name)) {
          throw new ConfigError(where, `adapter names unknown tool "${name}"`);
        }
      }
      for (const t of config.tools) {
        const hooks = appAdapter && Object.hasOwn(appAdapter.tools, t.name) ? appAdapter.tools[t.name] : undefined;
        const composed = typeof hooks?.compose === "function";
        if (composed && (t.request || t.list)) {
          throw new ConfigError(where, `tool "${t.name}" has a compose hook and also declares a request or list block`);
        }
        if (!composed && !t.request) {
          throw new ConfigError(where, `tool "${t.name}" declares no request and has no registered compose hook`);
        }
      }

      catalog.set(`${org}/${app}`, { org, app, config, roles });
    }
  }
  return catalog;
}

/**
 * The registry's other direction: every registered app must be a loaded app. Kept out of
 * `loadCatalog` because tests load fixture trees that contain none of the real orgs; the boot
 * path (`getCatalog`) and `orgs/orgs.test.ts` call this against the real tree.
 */
export function checkAdapterRegistry(
  catalog: Map<string, AppEntry>,
  adapters: Readonly<Record<string, AppAdapter>> = ADAPTERS,
): void {
  for (const key of Object.keys(adapters)) {
    if (!catalog.has(key)) {
      throw new ConfigError("lib/adapters/registry.ts", `registers "${key}", which is not a loaded org/app`);
    }
  }
}

function read(path: string, where: string, label: string): unknown {
  if (!existsSync(path)) throw new ConfigError(where, `missing ${label}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`${where}/${label}`, `invalid JSON: ${(e as Error).message}`);
  }
}
