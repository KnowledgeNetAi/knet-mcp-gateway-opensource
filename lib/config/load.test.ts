import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCatalog, checkAdapterRegistry, ConfigError } from "@/lib/config/load";
import type { AppAdapter } from "@/lib/adapters/types";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ORG = "acme";
const APP = "demo";

function validApi(): Record<string, unknown> {
  return {
    app: APP, displayName: "Demo", baseUrl: "https://example.test/v1",
    auth: { type: "oauth2_client_credentials", tokenUrl: "https://example.test/t",
            bodyFormat: "json", secrets: { client_id: `${ORG}/${APP}/client_id` },
            expiry: { field: "expires_in", coerce: "number", skewSeconds: 60 } },
    transport: { minIntervalMs: 1, timeoutMs: 1000,
                 retry: { attempts: 1, on: [], respectRetryAfter: false },
                 errors: { format: "json" } },
    tools: [{ name: "customer_get", description: "d", input: { type: "object" },
              request: { method: "GET", path: "/customers" } }],
  };
}

function validRoles(): Record<string, unknown> {
  return { roles: { tech: { tools: ["customer_get"], fields: {} } } };
}

function appDir(root: string): string {
  return join(root, ORG, APP);
}

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cat-"));
  mkdirSync(appDir(root), { recursive: true });
  return root;
}

function scaffold(roles: unknown = validRoles(), api: unknown = validApi()): string {
  const root = newRoot();
  writeFileSync(join(appDir(root), "api.json"), JSON.stringify(api));
  writeFileSync(join(appDir(root), "roles.json"), JSON.stringify(roles));
  return root;
}

describe("loadCatalog", () => {
  it("loads an app keyed by org/app", () => {
    const root = scaffold({ roles: { tech: { tools: ["customer_get"], fields: {} } } });
    const cat = loadCatalog(root);
    expect([...cat.keys()]).toEqual(["acme/demo"]);
    expect(cat.get("acme/demo")!.config.tools[0].name).toBe("customer_get");
  });

  it("fails the build when a role grants a tool api.json does not define", () => {
    const root = scaffold({ roles: { tech: { tools: ["ghost_tool"], fields: {} } } });
    expect(() => loadCatalog(root)).toThrow(ConfigError);
  });

  it("fails the build when the directory name does not match api.json app", () => {
    const root = scaffold();
    writeFileSync(join(appDir(root), "api.json"), JSON.stringify({ ...validApi(), app: "other" }));
    expect(() => loadCatalog(root)).toThrow(ConfigError);
  });

  it("returns an empty catalog when the root directory does not exist", () => {
    expect(loadCatalog("/no/such/dir")).toEqual(new Map());
  });

  it("fails the build when api.json violates the schema", () => {
    const { displayName: _displayName, ...withoutDisplayName } = validApi();
    const root = scaffold(validRoles(), withoutDisplayName);
    expect(() => loadCatalog(root)).toThrow(ConfigError);
  });

  it("fails the build when roles.json violates the schema (a deny key)", () => {
    const root = scaffold({
      roles: { tech: { tools: ["customer_get"], fields: { "*": { allow: ["*"], deny: ["x"] } } } },
    });
    expect(() => loadCatalog(root)).toThrow(ConfigError);
  });

  it("fails the build on malformed JSON", () => {
    const root = newRoot();
    writeFileSync(join(appDir(root), "api.json"), "{ not valid json");
    writeFileSync(join(appDir(root), "roles.json"), JSON.stringify(validRoles()));
    expect(() => loadCatalog(root)).toThrow(ConfigError);
  });

  it("fails the build when roles.json is missing", () => {
    const root = newRoot();
    writeFileSync(join(appDir(root), "api.json"), JSON.stringify(validApi()));
    expect(() => loadCatalog(root)).toThrow(ConfigError);
  });

  it("fails the build when a wildcard tool pattern matches zero tools", () => {
    const root = scaffold({ roles: { tech: { tools: ["ghost_*"], fields: {} } } });
    expect(() => loadCatalog(root)).toThrow(ConfigError);
  });

  it("passes when a wildcard tool pattern matches one or more tools", () => {
    const root = scaffold({ roles: { tech: { tools: ["customer_*"], fields: {} } } });
    const cat = loadCatalog(root);
    expect(cat.get("acme/demo")!.roles.roles.tech.tools).toEqual(["customer_*"]);
  });

  it("loads the on-disk valid fixture", () => {
    const fixturesRoot = join(__dirname, "__fixtures__");
    const cat = loadCatalog(fixturesRoot);
    expect([...cat.keys()]).toEqual(["acme/demo"]);
  });

  // --- Adapters: an adapter.ts runs only when registered, and must agree with api.json ---

  const compose = async () => ({});
  const withAdapterFile = (root: string): string => {
    writeFileSync(join(appDir(root), "adapter.ts"), "export default {};");
    return root;
  };

  it("fails the build when adapter.ts is present but the app is not registered", () => {
    const root = scaffold();
    writeFileSync(join(appDir(root), "adapter.ts"), "export default {};");
    expect(() => loadCatalog(root, {})).toThrow(ConfigError);
    expect(() => loadCatalog(root, {})).toThrow(/adapter\.ts is present but "acme\/demo" is not registered/);
  });

  it("loads a registered adapter.ts", () => {
    const root = scaffold();
    writeFileSync(join(appDir(root), "adapter.ts"), "export default {};");
    const reg: Record<string, AppAdapter> = { "acme/demo": { tools: { customer_get: { mapItem: (x) => x } } } };
    expect(() => loadCatalog(root, reg)).not.toThrow();
  });

  it("still loads normally when adapter.ts is absent", () => {
    const root = scaffold();
    expect(() => loadCatalog(root, {})).not.toThrow();
  });

  it("fails the build when an adapter names a tool api.json does not declare", () => {
    const root = withAdapterFile(scaffold());
    const reg: Record<string, AppAdapter> = { "acme/demo": { tools: { customer_gte: { mapItem: (x) => x } } } };
    expect(() => loadCatalog(root, reg)).toThrow(/adapter names unknown tool "customer_gte"/);
  });

  it("fails the build when a tool has a compose hook and a request block", () => {
    const root = withAdapterFile(scaffold());
    const reg: Record<string, AppAdapter> = { "acme/demo": { tools: { customer_get: { compose } } } };
    expect(() => loadCatalog(root, reg)).toThrow(/compose hook and also declares a request/);
  });

  it("fails the build when a tool has no request and no registered compose", () => {
    const api = validApi() as { tools: Record<string, unknown>[] };
    api.tools.push({ name: "summary", description: "d", input: { type: "object" } });
    const roles = { roles: { tech: { tools: ["customer_get", "summary"], fields: {} } } };
    const root = withAdapterFile(scaffold(roles, api));
    expect(() => loadCatalog(root, { "acme/demo": { tools: {} } })).toThrow(/"summary" declares no request and has no registered compose/);
    const reg: Record<string, AppAdapter> = { "acme/demo": { tools: { summary: { compose } } } };
    expect(() => loadCatalog(root, reg)).not.toThrow();
  });

  it("resolves adapter tool names as own properties only", () => {
    const api = validApi() as { tools: Record<string, unknown>[] };
    api.tools.push({ name: "constructor", description: "d", input: { type: "object" } });
    const roles = { roles: { tech: { tools: ["customer_get", "constructor"], fields: {} } } };
    const root = withAdapterFile(scaffold(roles, api));
    // `constructor` is inherited by every object; it must not count as a registered compose.
    expect(() => loadCatalog(root, { "acme/demo": { tools: {} } })).toThrow(/"constructor" declares no request/);
  });

  it("fails the build when an app is registered but has no adapter.ts", () => {
    const root = scaffold();
    expect(() => loadCatalog(root, { "acme/demo": { tools: {} } })).toThrow(/registered .* but has no adapter\.ts/);
  });

  it.each([["hooks.ts"], ["adapter.js"], ["adapter.tsx"], ["helper.mjs"]])(
    "fails the build on a stray code file %s",
    (f) => {
      const root = scaffold();
      writeFileSync(join(appDir(root), f), "export {};");
      expect(() => loadCatalog(root, {})).toThrow(/unexpected code file/);
    },
  );

  it("allows test files and non-code files beside the config", () => {
    const root = scaffold();
    writeFileSync(join(appDir(root), "adapter.test.ts"), "");
    writeFileSync(join(appDir(root), "NOTES.md"), "");
    expect(() => loadCatalog(root, {})).not.toThrow();
  });

  it("fails the build on a subdirectory in an app directory", () => {
    const root = scaffold();
    mkdirSync(join(appDir(root), "adapters"));
    expect(() => loadCatalog(root, {})).toThrow(/unexpected subdirectory "adapters"/);
  });

  it("checkAdapterRegistry refuses a registered app that is not loaded", () => {
    const root = scaffold();
    const cat = loadCatalog(root, {});
    expect(() => checkAdapterRegistry(cat, { "acme/demo": { tools: {} } })).not.toThrow();
    expect(() => checkAdapterRegistry(cat, { "ghost/app": { tools: {} } })).toThrow(/registers "ghost\/app"/);
  });

  // --- "ALSO FOLD IN" (Task 12 final review): Vault secret paths must belong to their org/app ---

  it("fails the build when a secret path does not start with '<org>/<app>/'", () => {
    const api = validApi() as { auth: { secrets: Record<string, string> } };
    api.auth.secrets = { client_id: "other-org/other-app/client_id" };
    const root = scaffold(validRoles(), api);
    expect(() => loadCatalog(root)).toThrow(ConfigError);
    expect(() => loadCatalog(root)).toThrow(/auth\.secrets\.client_id/);
  });

  it("fails the build when a secret path belongs to the right org but the wrong app", () => {
    const api = validApi() as { auth: { secrets: Record<string, string> } };
    api.auth.secrets = { client_id: `${ORG}/some-other-app/client_id` };
    const root = scaffold(validRoles(), api);
    expect(() => loadCatalog(root)).toThrow(ConfigError);
  });

  it("passes when every secret path starts with '<org>/<app>/'", () => {
    const api = validApi() as { auth: { secrets: Record<string, string> } };
    api.auth.secrets = { client_id: `${ORG}/${APP}/client_id`, client_secret: `${ORG}/${APP}/client_secret` };
    const root = scaffold(validRoles(), api);
    expect(() => loadCatalog(root)).not.toThrow();
  });
});

describe("loadCatalog write-tool grants", () => {
  /** `validApi()` plus one write tool, so a role can be tested against it. */
  function apiWithWriteTool(): Record<string, unknown> {
    const api = validApi();
    (api.tools as Record<string, unknown>[]).push({
      name: "customer_update",
      description: "d",
      input: { type: "object", properties: { fields: { type: "object" } }, required: ["fields"] },
      request: { method: "PATCH", path: "/customers/{{id}}", body: { properties: "{{fields}}" } },
      write: { fieldsFrom: "fields" },
    });
    return api;
  }

  it("fails the build when a role grants a write tool with no writes allowlist", () => {
    // Deny-by-default is the right RUNTIME answer and the handler enforces it.
    // It is the wrong thing to discover from committed config: the role reads
    // as a working grant and writes nothing, and nobody finds out until the
    // customer's first attempted write.
    const root = scaffold(
      { roles: { editor: { tools: ["customer_get", "customer_update"], fields: {} } } },
      apiWithWriteTool(),
    );
    expect(() => loadCatalog(root)).toThrow(/declares no "writes" allowlist/);
  });

  it("accepts the same role once it names the writable fields", () => {
    const root = scaffold(
      {
        roles: {
          editor: {
            tools: ["customer_get", "customer_update"],
            fields: {},
            writes: { customer_update: { allow: ["first_name", "last_name"] } },
          },
        },
      },
      apiWithWriteTool(),
    );
    expect(() => loadCatalog(root)).not.toThrow();
  });

  it("accepts a writes rule reaching the tool through a wildcard TOOL pattern", () => {
    // The wildcard ban is on field names, not on tool patterns — `customer_*`
    // selects which tools a rule covers, exactly as it does for `fields`.
    const root = scaffold(
      {
        roles: {
          editor: {
            tools: ["customer_*"],
            fields: {},
            writes: { "customer_*": { allow: ["first_name"] } },
          },
        },
      },
      apiWithWriteTool(),
    );
    expect(() => loadCatalog(root)).not.toThrow();
  });

  it("does not require a writes allowlist from a role that only grants read tools", () => {
    const root = scaffold(
      { roles: { viewer: { tools: ["customer_get"], fields: {} } } },
      apiWithWriteTool(),
    );
    expect(() => loadCatalog(root)).not.toThrow();
  });
});

