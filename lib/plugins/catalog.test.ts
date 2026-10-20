import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { listPluginsForOrg, zipPluginForOrg } from "@/lib/plugins/catalog";

function write(root: string, path: string, body: string) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function plugin(root: string, name: string, url: string, manifestName = name) {
  write(root, `${name}/.claude-plugin/plugin.json`, JSON.stringify({ name: manifestName, displayName: `${name} display`, version: "1.2.3", description: "d" }));
  write(root, `${name}/.mcp.json`, JSON.stringify({ mcpServers: { s: { type: "http", url } } }));
  write(root, `${name}/skills/one/SKILL.md`, "---\nname: one\n---\n");
  write(root, `${name}/evals/case.yaml`, "prompt: x");
  write(root, `${name}/evals/results/run.json`, "{}");
  write(root, `${name}/.DS_Store`, "junk");
}

describe("plugin catalog", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "plugins-"));
    plugin(root, "acme-crm", "https://gateway.example.com/mcp/acme/crm");
    plugin(root, "acme-all", "https://gateway.example.com/mcp/acme");
    plugin(root, "other-crm", "https://gateway.example.com/mcp/other/crm");
    plugin(root, "misnamed", "https://gateway.example.com/mcp/acme/crm", "something-else");
    write(root, "shared/acme-crm.md", "not a plugin");
  });

  it("lists only plugins whose connector targets the org", () => {
    expect(listPluginsForOrg("acme", root).map((p) => p.name)).toEqual(["acme-all", "acme-crm"]);
    expect(listPluginsForOrg("other", root).map((p) => p.name)).toEqual(["other-crm"]);
    expect(listPluginsForOrg("nobody", root)).toEqual([]);
  });

  it("does not treat an org slug as a prefix match", () => {
    plugin(root, "acmeco-crm", "https://gateway.example.com/mcp/acmeco/crm");
    expect(listPluginsForOrg("acme", root).map((p) => p.name)).not.toContain("acmeco-crm");
  });

  it("skips a plugin whose manifest name disagrees with its directory", () => {
    expect(listPluginsForOrg("acme", root).map((p) => p.name)).not.toContain("misnamed");
  });

  it("zips the plugin without evals or .DS_Store", () => {
    const result = zipPluginForOrg("acme", "acme-crm", root);
    expect(result?.summary.version).toBe("1.2.3");
    const files = unzipSync(result!.zip);
    expect(Object.keys(files).sort()).toEqual([".claude-plugin/plugin.json", ".mcp.json", "skills/one/SKILL.md"]);
    expect(strFromU8(files["skills/one/SKILL.md"])).toContain("name: one");
  });

  it("refuses another org's plugin and any name that is not a listed plugin", () => {
    expect(zipPluginForOrg("acme", "other-crm", root)).toBeNull();
    expect(zipPluginForOrg("acme", "../acme-crm", root)).toBeNull();
    expect(zipPluginForOrg("acme", "shared", root)).toBeNull();
  });

  it("finds the committed demo plugin for demo only", () => {
    expect(listPluginsForOrg("demo").map((p) => p.name)).toEqual(["demo-helloworld"]);
    expect(listPluginsForOrg("globex")).toEqual([]);
  });
});
