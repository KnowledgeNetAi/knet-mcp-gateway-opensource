import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Plugins under plugins/ ship to customers as zips (scripts/build-plugin.sh).
 * claude.ai gives a plugin's skills no shared folder, so each skill carries a
 * copy of plugins/shared/<plugin>.md; these tests fail when a committed copy
 * drifts from that source, which is the one way the copies go wrong silently.
 */
const PLUGINS = join(__dirname);

const plugins = readdirSync(PLUGINS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(PLUGINS, d.name, ".claude-plugin", "plugin.json")))
  .map((d) => d.name);

describe("plugins", () => {
  it("finds at least one plugin", () => {
    expect(plugins.length).toBeGreaterThan(0);
  });

  describe.each(plugins)("%s", (name) => {
    const root = join(PLUGINS, name);
    const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
    const skills = readdirSync(join(root, "skills"));

    it("is named after its directory", () => {
      expect(manifest.name).toBe(name);
    });

    it.each(skills)("skill %s carries an up-to-date copy of the shared reference", (skill) => {
      const shared = readFileSync(join(PLUGINS, "shared", `${name}.md`), "utf8");
      // The copy is named for the app: the plugin name after its first "-"
      // (scripts/build-plugin.sh), e.g. demo-helloworld -> references/helloworld.md.
      const app = name.slice(name.indexOf("-") + 1);
      const copy = readFileSync(join(root, "skills", skill, "references", `${app}.md`), "utf8");
      expect(copy, "run scripts/build-plugin.sh " + name).toBe(shared);
    });

    it.each(skills)("skill %s has frontmatter whose name matches its directory", (skill) => {
      const body = readFileSync(join(root, "skills", skill, "SKILL.md"), "utf8");
      expect(body).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---\\n`));
    });

    it("bundles one https gateway app endpoint per server", () => {
      const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
      for (const server of Object.values<{ type: string; url: string }>(mcp.mcpServers)) {
        expect(server.type).toBe("http");
        // Tokens are bound to the gateway's public origin (OAuth resource), so a plugin must
        // name that origin over https and one app's endpoint, never a deployment's internal host.
        expect(server.url).toMatch(/^https:\/\/[a-z0-9.-]+\/mcp\/[a-z0-9-]+\/[a-z0-9-]+$/);
      }
    });
  });
});
