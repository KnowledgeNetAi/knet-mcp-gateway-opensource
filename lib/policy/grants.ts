import type { Grant, RolesConfig, ToolDef } from "@/lib/types";
import { matchesToolPattern } from "./paths";

/**
 * Union the caller's roles into one grant.
 *
 * Additive across roles for tool access: intersection would mean granting
 * someone an extra role removes access, which nobody predicts. An unknown
 * role is inert rather than fatal — role_assignments rows are mutable by
 * admins, and a stale row must never be able to break the gateway.
 *
 * A role's field allowlist for a tool pattern only ever applies to tools
 * that SAME role also grants via its own `tools` list — a field rule in a
 * role that does not grant the matching tool has no effect. This keeps each
 * role auditable as a self-contained capability of (tools it grants, fields
 * it may see on those tools): the wider reading — any held role's field
 * rules apply to any tool granted by any held role — would let one role
 * silently widen access to a tool it never named, creating ambient
 * authority that only shows up once two specific roles are combined. Two
 * roles that both grant the same tool still union their field rules for it;
 * that is where "additive" remains true.
 */
export function computeGrant(
  roleNames: string[],
  roles: RolesConfig,
  tools: ToolDef[],
): Grant {
  const toolNames = tools.map((t) => t.name);
  const writeTools = new Set(tools.filter((t) => t.write).map((t) => t.name));
  const granted = new Set<string>();
  const fields = new Map<string, Set<string>>();
  const writes = new Map<string, Set<string>>();
  const unknownRoles: string[] = [];

  for (const roleName of roleNames) {
    // Use an own-property check rather than a bare `roles.roles[roleName]`
    // lookup: roles.roles is parsed from JSON, so it is a plain object, and
    // a role name that happens to spell an Object.prototype property (e.g.
    // "constructor", "toString", "hasOwnProperty") would otherwise resolve
    // through the prototype chain to a truthy, non-RoleDef value — bypassing
    // the unknown-role check below and then throwing when `role.tools` is
    // iterated. Role names are mutable, admin-controlled DB rows; a stale or
    // malicious one must be inert, never fatal.
    const role = Object.hasOwn(roles.roles, roleName) ? roles.roles[roleName] : undefined;
    if (!role) {
      if (!unknownRoles.includes(roleName)) unknownRoles.push(roleName);
      continue;
    }

    // What THIS role grants, via its own tools list only — the scope a
    // field rule from this same role is allowed to widen.
    const roleGranted = new Set<string>();
    for (const pattern of role.tools) {
      for (const name of toolNames) {
        if (matchesToolPattern(name, pattern)) {
          granted.add(name);
          roleGranted.add(name);
        }
      }
    }

    for (const [toolPattern, rule] of Object.entries(role.fields)) {
      for (const name of toolNames) {
        if (!roleGranted.has(name)) continue;
        if (!matchesToolPattern(name, toolPattern)) continue;
        const set = fields.get(name) ?? new Set<string>();
        rule.allow.forEach((a) => set.add(a));
        fields.set(name, set);
      }
    }

    // Write allowlists, under exactly the same scoping rule as `fields`
    // above: a rule in this role only ever applies to a tool THIS role also
    // granted, so holding a second role can never silently widen what the
    // first one may write. Restricted further to tools that actually declare
    // a `write` block — a `writes` entry naming a read tool grants nothing
    // and must not quietly become ambient authority if that tool later gains
    // one.
    for (const [toolPattern, rule] of Object.entries(role.writes ?? {})) {
      for (const name of toolNames) {
        if (!roleGranted.has(name)) continue;
        if (!writeTools.has(name)) continue;
        if (!matchesToolPattern(name, toolPattern)) continue;
        const set = writes.get(name) ?? new Set<string>();
        rule.allow.forEach((a) => set.add(a));
        writes.set(name, set);
      }
    }
  }

  // Every granted tool gets an entry, so a missing field rule reads as
  // "nothing allowed" rather than "not configured". Frozen: a Grant is
  // resolved access for one principal and a plausible thing to cache: an
  // in-place mutation by a consumer (e.g. `.sort()`) must not be able to
  // silently rewrite policy shared with other callers.
  const out = new Map<string, readonly string[]>();
  for (const name of granted) out.set(name, Object.freeze([...(fields.get(name) ?? [])]));

  // Same shape and the same reasoning as `out`: every granted WRITE tool gets
  // an entry, so a missing rule reads as "may write nothing" rather than "not
  // configured". A granted read tool gets no entry at all, which is the same
  // answer by a shorter route.
  const writesOut = new Map<string, readonly string[]>();
  for (const name of granted) {
    if (writeTools.has(name)) writesOut.set(name, Object.freeze([...(writes.get(name) ?? [])]));
  }

  return { tools: granted, fields: out, writes: writesOut, unknownRoles };
}
