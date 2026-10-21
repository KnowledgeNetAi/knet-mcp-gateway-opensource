import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { validRolesForOrg } from "@/lib/admin/invite";
import type { AdminRole } from "@/lib/authz/viewer";

/**
 * `reason` is a closed union so a caller (Server Action) can branch on it
 * without string-matching `.message`:
 *   - "last_admin": the mutation would leave an org with zero `org_admin`
 *     members (demoting or removing its only one). Nothing is written.
 *   - "unknown_role": a `dataRoles` entry is not defined by any app in the
 *     org's committed `roles.json`. Nothing is written.
 *   - "not_a_member": the target user has no membership row in this org.
 *   - "db_error": a `memberships`/`role_assignments`/`api_keys` write failed.
 */
export class MemberError extends Error {
  constructor(
    public readonly reason: "last_admin" | "unknown_role" | "not_a_member" | "db_error",
    message: string,
  ) {
    super(message);
    this.name = "MemberError";
  }
}

export interface Member {
  userId: string;
  email: string | null;
  adminRole: AdminRole;
  dataRoles: string[];
  invitedAt: string | null;
  acceptedAt: string | null;
  lastSignInAt: string | null;
  pending: boolean;
}

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Reads `memberships` + `role_assignments`, then resolves each member's
 * email and `last_sign_in_at` through `supabase.auth.admin.listUsers`.
 * supabase-js has no admin get-by-id-list call — `lib/admin/invite.ts`
 * documents this same constraint for get-by-email, and hits the same 1000
 * row page size for the same reason: neither is expected to matter until an
 * org has a genuinely large membership.
 *
 * `pending` is derived from email confirmation, not sign-in. An invite is
 * accepted when Supabase confirms the address; requiring a subsequent login
 * made accepted users look pending until they returned to the gateway.
 */
export async function listMembers(orgId: string): Promise<Member[]> {
  const supabase = createAdminClient();

  const { data: membershipRows, error: membershipErr } = await supabase
    .from("memberships")
    .select("user_id, admin_role, invited_at")
    .eq("org_id", orgId);
  if (membershipErr) {
    throw new MemberError(
      "db_error",
      `error listing members for org "${orgId}": ${membershipErr.message}`,
    );
  }

  const { data: roleRows, error: roleErr } = await supabase
    .from("role_assignments")
    .select("user_id, role")
    .eq("org_id", orgId);
  if (roleErr) {
    throw new MemberError(
      "db_error",
      `error listing role assignments for org "${orgId}": ${roleErr.message}`,
    );
  }

  const dataRolesByUser = new Map<string, string[]>();
  for (const row of (roleRows ?? []) as Array<{ user_id: string; role: string }>) {
    const roles = dataRolesByUser.get(row.user_id) ?? [];
    roles.push(row.role);
    dataRolesByUser.set(row.user_id, roles);
  }

  const { data: page, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) {
    throw new MemberError("db_error", `error listing auth users: ${listErr.message}`);
  }
  const usersById = new Map(
    (page?.users ?? []).map((u: { id: string; email?: string; last_sign_in_at?: string; email_confirmed_at?: string }) => [
      u.id,
      u,
    ]),
  );

  return (
    (membershipRows ?? []) as Array<{
      user_id: string;
      admin_role: AdminRole;
      invited_at: string | null;
    }>
  ).map((row) => {
    const user = usersById.get(row.user_id);
    const lastSignInAt = user?.last_sign_in_at ?? null;
    const acceptedAt = user?.email_confirmed_at ?? null;
    return {
      userId: row.user_id,
      email: user?.email ?? null,
      adminRole: row.admin_role,
      dataRoles: (dataRolesByUser.get(row.user_id) ?? []).sort(),
      invitedAt: row.invited_at ?? null,
      acceptedAt,
      lastSignInAt,
      pending: acceptedAt === null,
    };
  });
}

/**
 * Sets the org-scoped platform role through a database function that locks
 * the organization before checking the last-admin invariant and updating.
 * Keeping both operations in one transaction prevents concurrent demotions
 * from each observing a stale count and leaving the org unmanaged.
 */
export async function setAdminRole(
  orgId: string,
  userId: string,
  adminRole: AdminRole,
): Promise<void> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("set_membership_admin_role", {
    p_org_id: orgId,
    p_user_id: userId,
    p_admin_role: adminRole,
  });
  if (error) {
    throw new MemberError(
      "db_error",
      `error setting admin role for user "${userId}" in org "${orgId}": ${error.message}`,
    );
  }
  if (data === "last_admin" || data === "not_a_member") {
    throw new MemberError(data, `cannot set admin role for user "${userId}" in org "${orgId}": ${data}`);
  }
  if (data !== "ok") {
    throw new MemberError("db_error", `unexpected set_membership_admin_role result: ${String(data)}`);
  }
}

/**
 * Validates every role via `validRolesForOrg` BEFORE writing anything, then
 * reconciles `role_assignments` against the requested set: deletes the roles
 * that are gone, inserts the ones that are new, and leaves unchanged roles
 * alone. Never touches a platform role — this table is data-access roles
 * only (Global Constraints).
 */
/**
 * Resolves `email` to a member of `orgId` before an org admin re-sends or
 * copies a sign-in link for it. Both actions take the address from a form
 * field, and `generateLink` mints a session link for whatever address it is
 * given, so without this check any org admin could take over a pending user in
 * another org. Returns null when the address is not a member of this org.
 *
 * `beyondOrg` is true when the person also belongs to another org or holds
 * super admin. Their sign-in link opens more than this org, so only a super
 * admin may copy it; re-sending is still fine because the mail goes to the
 * person, not the admin.
 */
export async function memberForLink(
  orgId: string,
  email: string,
): Promise<{ userId: string; beyondOrg: boolean } | null> {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return null;

  const supabase = createAdminClient();
  const { data: page, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) throw new MemberError("db_error", `error listing auth users: ${listErr.message}`);
  const user = (page?.users ?? []).find(
    (u: { id: string; email?: string }) => u.email?.toLowerCase() === wanted,
  );
  if (!user) return null;

  const { data: rows, error: membershipErr } = await supabase
    .from("memberships")
    .select("org_id")
    .eq("user_id", user.id);
  if (membershipErr) throw new MemberError("db_error", `error reading memberships: ${membershipErr.message}`);
  const orgIds = ((rows ?? []) as Array<{ org_id: string }>).map((r) => r.org_id);
  if (!orgIds.includes(orgId)) return null;

  const { data: adminRow, error: adminErr } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (adminErr) throw new MemberError("db_error", `error reading platform_admins: ${adminErr.message}`);

  return { userId: user.id, beyondOrg: orgIds.some((id) => id !== orgId) || adminRow !== null };
}

export async function setDataRoles(
  orgId: string,
  orgSlug: string,
  userId: string,
  roles: string[],
): Promise<void> {
  const validRoles = new Set(validRolesForOrg(orgSlug));
  for (const role of roles) {
    if (!validRoles.has(role)) {
      throw new MemberError(
        "unknown_role",
        `role "${role}" is not defined for org "${orgSlug}"`,
      );
    }
  }

  const supabase = createAdminClient();

  // Role rows for someone outside the org would still be honored by the MCP
  // path, which reads `role_assignments` by user and org alone.
  const { data: membership, error: membershipErr } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (membershipErr) {
    throw new MemberError("db_error", `error reading membership: ${membershipErr.message}`);
  }
  if (!membership) {
    throw new MemberError("not_a_member", `user "${userId}" is not a member of org "${orgId}"`);
  }

  const { data: existingRows, error: existingErr } = await supabase
    .from("role_assignments")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", userId);
  if (existingErr) {
    throw new MemberError(
      "db_error",
      `error reading existing roles for user "${userId}" in org "${orgId}": ${existingErr.message}`,
    );
  }

  const existing = new Set(((existingRows ?? []) as Array<{ role: string }>).map((r) => r.role));
  const next = new Set(roles);

  const toDelete = [...existing].filter((role) => !next.has(role));
  const toInsert = [...next].filter((role) => !existing.has(role));

  for (const role of toDelete) {
    const { error } = await supabase
      .from("role_assignments")
      .delete()
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .eq("role", role);
    if (error) {
      throw new MemberError(
        "db_error",
        `error removing role "${role}" from user "${userId}" in org "${orgId}": ${error.message}`,
      );
    }
  }

  for (const role of toInsert) {
    const { error } = await supabase
      .from("role_assignments")
      .insert({ org_id: orgId, user_id: userId, role });
    if (error) {
      throw new MemberError(
        "db_error",
        `error adding role "${role}" to user "${userId}" in org "${orgId}": ${error.message}`,
      );
    }
  }
}

/**
 * Removes a member from an org. The database function runs three writes in
 * this exact order, in one transaction while holding the same per-org lock
 * used by `setAdminRole`:
 *
 *   1. revoke this org's live `api_keys` rows for the user (covers manually
 *      issued `kngw_` keys AND OAuth tokens — phase 2 decision 2 put those
 *      in `api_keys` too, with `source = 'oauth'`);
 *   2. delete their `role_assignments` rows;
 *   3. delete their `memberships` row.
 *
 * Key revocation is FIRST (spec decision 7) so that a failure partway
 * through this function leaves access revoked rather than membership
 * deleted with keys still live — a "removed" member who keeps working
 * credentials is the worst outcome this feature can produce.
 *
 * Last-admin protection mirrors `setAdminRole`: the org's final `org_admin`
 * cannot be removed.
 */
export async function removeMember(orgId: string, userId: string): Promise<void> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("remove_org_member", {
    p_org_id: orgId,
    p_user_id: userId,
  });
  if (error) {
    throw new MemberError(
      "db_error",
      `error removing user "${userId}" from org "${orgId}": ${error.message}`,
    );
  }
  if (data === "last_admin" || data === "not_a_member") {
    throw new MemberError(data, `cannot remove user "${userId}" from org "${orgId}": ${data}`);
  }
  if (data !== "ok") {
    throw new MemberError("db_error", `unexpected remove_org_member result: ${String(data)}`);
  }
}
