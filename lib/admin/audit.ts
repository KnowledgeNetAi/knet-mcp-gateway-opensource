import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Viewer } from "@/lib/authz/viewer";

export type AdminAction =
  | "org.create"
  | "member.invite"
  | "member.remove"
  | "member.admin_role"
  | "role.assign"
  | "role.revoke"
  | "credential.write"
  | "credential.test"
  | "apikey.issue"
  | "apikey.revoke"
  | "superadmin.grant"
  | "superadmin.revoke";

const REDACTED = "[redacted]";

/**
 * Property names whose VALUE is never stored, at any depth.
 *
 * Deliberately excludes `key`: a property literally named `key` is how a
 * caller records *which* other field was written (e.g.
 * `{ key: "client_secret" }` documents that the client secret was rotated,
 * without itself carrying the secret's value) — that is legitimate,
 * non-sensitive audit data, and blanking it would destroy the one thing the
 * audit row exists to answer ("what got touched") while adding no
 * confidentiality benefit, since the actual payload lives under whatever key
 * `key`'s value names (`client_secret`, `token`, ...) and is redacted there.
 */
const REDACT_KEYS = new Set([
  "secret",
  "password",
  "client_secret",
  "target_id",
  "token",
  "api_key",
]);

/**
 * How deep `redactDetail` will descend before giving up on a subtree and
 * replacing it with a marker instead of continuing. `detail` is caller-built
 * admin-console data (never raw upstream/tool payloads), so this is a
 * defensive backstop, not an expected path.
 */
const MAX_REDACT_DEPTH = 20;
const MAX_DEPTH_MARKER = "[max depth exceeded]";
const CIRCULAR = "[circular]";
const UNREDACTABLE = "[unredactable]";

/**
 * Redact `detail` for storage: any object key literally named in
 * `REDACT_KEYS` has its VALUE replaced with `"[redacted]"`, at any depth —
 * a secret can arrive nested inside a filter/params-shaped object, not only
 * at the top level. Never throws: a hostile or merely pathological subtree
 * (a cycle, a throwing getter) is isolated to a marker for that subtree
 * alone, never allowed to take the rest of `detail` down with it.
 */
function redactDetail(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_REDACT_DEPTH) return MAX_DEPTH_MARKER;

  try {
    if (ancestors.has(value)) return CIRCULAR;
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => {
          try {
            return redactDetail(item, ancestors, depth + 1);
          } catch {
            return UNREDACTABLE;
          }
        });
      }

      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (key === "__proto__") continue;
        try {
          if (REDACT_KEYS.has(key)) {
            out[key] = REDACTED;
            continue;
          }
          out[key] = redactDetail((value as Record<string, unknown>)[key], ancestors, depth + 1);
        } catch {
          out[key] = UNREDACTABLE;
        }
      }
      return out;
    } finally {
      ancestors.delete(value);
    }
  } catch {
    return UNREDACTABLE;
  }
}

/** Built only from a caught value's own safe primitives — never the value itself. */
function safeErrorMessage(e: unknown): string {
  try {
    if (e instanceof Error && typeof e.message === "string") return e.message;
    if (typeof e === "string") return e;
    return "non-Error value thrown";
  } catch {
    return "error message unreadable";
  }
}

/**
 * Log a broken audit write loudly instead of swallowing it silently — through
 * `console.error`, itself guarded (some runtimes patch it to throw), and
 * built exclusively from `safeErrorMessage`, never from the caught value
 * itself, so this reporting path cannot throw a second time.
 */
function logWriteFailure(e: unknown): void {
  try {
    console.error(
      JSON.stringify({ event: "admin_audit.write_failed", error: safeErrorMessage(e) }),
    );
  } catch {
    // console.error can itself be patched to throw. There is nothing further
    // this function can safely do but not throw.
  }
}

/**
 * Write one row to `admin_audit_events`. Never throws and never fails the
 * action that triggered it — mirrors `lib/audit/log.ts`'s `writeAudit`
 * for the same reason: an audit write is a side effect of an admin action,
 * not a precondition for it, and the failure-reporting path itself must be
 * incapable of throwing.
 *
 * `actor_user_id` and `actor_was_super` are derived from `row.viewer`, never
 * from a caller-supplied flag — a caller must not be able to under-report
 * that a super admin performed an action.
 */
export async function writeAdminAudit(row: {
  viewer: Viewer;
  orgId: string | null;
  action: AdminAction;
  target?: string;
  detail?: Record<string, unknown>;
  outcome: "ok" | "denied" | "error";
}): Promise<void> {
  try {
    const detail =
      row.detail === undefined ? null : redactDetail(row.detail, new Set<object>(), 0);

    const { error } = await createAdminClient().from("admin_audit_events").insert({
      actor_user_id: row.viewer.userId,
      actor_was_super: row.viewer.isSuperAdmin,
      org_id: row.orgId,
      action: row.action,
      target: row.target ?? null,
      detail,
      outcome: row.outcome,
    });

    if (error) throw new Error(error.message);
  } catch (e) {
    logWriteFailure(e);
  }
}
