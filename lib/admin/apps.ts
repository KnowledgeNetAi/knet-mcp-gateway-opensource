import "server-only";
import { getCatalog } from "@/lib/mcp/catalog";
import { computeGrant } from "@/lib/policy/grants";

export interface AppRoleAccess {
  name: string;
  toolCount: number;
  writeToolCount: number;
}

export interface AppToolAccess {
  name: string;
  description: string;
  method: string;
  write: boolean;
  roles: Array<{ name: string; granted: boolean; fields: readonly string[]; writes: readonly string[] }>;
}

export interface AppAccessDetail {
  app: string;
  displayName: string;
  baseUrl: string;
  roles: AppRoleAccess[];
  tools: AppToolAccess[];
}

/** Expands wildcard policy into the effective per-role/per-tool matrix shown to admins. */
export function appAccessDetail(orgSlug: string, appSlug: string): AppAccessDetail | null {
  const entry = getCatalog().get(`${orgSlug}/${appSlug}`);
  if (!entry) return null;

  const roleNames = Object.keys(entry.roles.roles).sort();
  const grants = new Map(
    roleNames.map((name) => [name, computeGrant([name], entry.roles, entry.config.tools)]),
  );

  return {
    app: entry.app,
    displayName: entry.config.displayName,
    baseUrl: entry.config.baseUrl,
    roles: roleNames.map((name) => {
      const grant = grants.get(name)!;
      return { name, toolCount: grant.tools.size, writeToolCount: grant.writes.size };
    }),
    tools: entry.config.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      method: tool.request?.method ?? "LOCAL",
      write: Boolean(tool.write),
      roles: roleNames.map((name) => {
        const grant = grants.get(name)!;
        return {
          name,
          granted: grant.tools.has(tool.name),
          fields: grant.fields.get(tool.name) ?? [],
          writes: grant.writes.get(tool.name) ?? [],
        };
      }),
    })),
  };
}
