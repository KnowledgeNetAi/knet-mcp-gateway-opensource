import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCatalog } from "@/lib/mcp/catalog";
import type { AdminRole } from "@/lib/authz/viewer";

export interface InviteResult {
  userId: string;
  email: string;
  orgSlug: string;
  /** null when the caller left the existing platform role untouched. */
  adminRole: AdminRole | null;
  dataRoles: string[];
  alreadyExisted: boolean;
}

/**
 * `reason` is a closed union so a caller (CLI or Server Action) can branch on
 * it without string-matching `.message`:
 *   - "no_such_org": no row in `organizations` for the given slug.
 *   - "unknown_role": a `dataRoles` entry is not defined by any app in the
 *     org's committed `roles.json`. Nothing is written when this fires.
 *   - "invite_failed": `inviteUserByEmail` failed for a reason other than
 *     the email already having an account.
 *   - "last_admin": re-inviting an existing member with a lower admin role
 *     would leave the org with no org_admin. Nothing is written.
 *   - "db_error": a `memberships`/`role_assignments` write failed.
 */
export class InviteError extends Error {
  constructor(
    public readonly reason: "no_such_org" | "unknown_role" | "invite_failed" | "last_admin" | "db_error",
    message: string,
  ) {
    super(message);
    this.name = "InviteError";
  }
}

/**
 * Every data role any app in this org defines, sorted. The catalog is keyed
 * `${org}/${app}`; a role is valid for the org if ANY of the org's apps
 * define it. This is the single source of truth for "which data roles can
 * this org's members hold" — the request-time handler (`lib/policy/*`) and
 * the invite path both resolve roles against the same committed
 * `roles.json` via this same `getCatalog()`, so they can never drift apart.
 */
export function validRolesForOrg(orgSlug: string): string[] {
  const catalog = getCatalog();
  const roles = new Set<string>();
  for (const entry of catalog.values()) {
    if (entry.org !== orgSlug) continue;
    for (const roleName of Object.keys(entry.roles.roles)) roles.add(roleName);
  }
  return [...roles].sort();
}

/**
 * Sends the Supabase invite email. If the email already belongs to a user,
 * `inviteUserByEmail` errors — that is the expected, safe-to-ignore shape of
 * re-inviting someone already invited, not a failure. Look the existing user
 * up instead of propagating the error. Mirrors `scripts/invite.ts`'s
 * `inviteOrFindUser`, moved here so both the CLI and the console share it.
 */
async function inviteOrFindUser(
  supabase: ReturnType<typeof createAdminClient>,
  email: string,
): Promise<{ userId: string; alreadyExisted: boolean }> {
  const { data, error } = await supabase.auth.admin.inviteUserByEmail(email);
  if (!error) return { userId: data.user.id, alreadyExisted: false };

  const alreadyExists =
    error.code === "email_exists" ||
    error.code === "user_already_exists" ||
    /already.*registered/i.test(error.message);
  if (!alreadyExists) {
    throw new InviteError("invite_failed", `error inviting ${email}: ${error.message}`);
  }

  // supabase-js has no admin "get user by email" call — paginate listUsers
  // and match by email, same approach as `scripts/invite.ts` today.
  const { data: page, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) {
    throw new InviteError(
      "invite_failed",
      `error looking up existing user ${email}: ${listErr.message}`,
    );
  }
  const existing = page.users.find(
    (u: { id: string; email?: string }) => u.email?.toLowerCase() === email.toLowerCase(),
  );
  if (!existing) {
    throw new InviteError(
      "invite_failed",
      `inviteUserByEmail reported "${email}" already exists, but no matching user was found`,
    );
  }
  return { userId: existing.id, alreadyExisted: true };
}

/**
 * The single invite implementation, shared by `scripts/invite.ts` and the
 * admin console. Order of operations, unchanged from what `scripts/invite.ts`
 * did before this extraction:
 *
 *   1. Resolve the org by slug.
 *   2. Validate EVERY entry of `dataRoles` via `validRolesForOrg`. This is
 *      the step that stops an invitation into a role git does not define,
 *      which would otherwise produce a user who can reach nothing, with no
 *      error anywhere until they complain. Nothing is written if this fails.
 *   3. `inviteUserByEmail`, falling back to a `listUsers` lookup when the
 *      email already has an account (idempotent re-invite).
 *   4. Upsert `memberships` with `admin_role`, `invited_by`, `invited_at`.
 *   5. Upsert one `role_assignments` row per data role (`ignoreDuplicates`).
 *
 * `invitedBy` is `string | null` rather than `string` — a CLI run has no
 * acting user and passes `null`; only the console's Server Action, running
 * on behalf of a signed-in org_admin/super_admin, passes a real user id.
 *
 * `adminRole` is OPTIONAL, and omitting it is not the same as passing
 * "member". Omitted, `admin_role` is left out of the upsert payload
 * entirely: a new row takes the column's DB default ("member"), and an
 * EXISTING row keeps whatever it already had. Passing "member" explicitly
 * would instead write that value, silently demoting an org_admin who is
 * re-invited — which is exactly what `scripts/invite.ts` does on every run,
 * and its whole documented contract is that re-running it is safe. Only a
 * caller that genuinely means to set the platform role (the console's invite
 * form) passes this.
 *
 * `role_assignments` NEVER receives a platform role (`org_admin`, `member`,
 * `super_admin`) — that table is for git-defined data-access roles only.
 */
export async function inviteMember(input: {
  orgSlug: string;
  email: string;
  adminRole?: AdminRole;
  dataRoles: string[];
  invitedBy: string | null;
}): Promise<InviteResult> {
  const { orgSlug, email, adminRole, dataRoles, invitedBy } = input;
  const supabase = createAdminClient();

  // 1. Resolve the org by slug.
  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("id, slug")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (orgErr) {
    throw new InviteError("db_error", `error looking up org "${orgSlug}": ${orgErr.message}`);
  }
  if (!org) {
    throw new InviteError("no_such_org", `no organization with slug "${orgSlug}"`);
  }
  const orgRow = org as { id: string; slug: string };

  // 2. Validate every data role before touching anything else.
  const validRoles = validRolesForOrg(orgSlug);
  const validRoleSet = new Set(validRoles);
  for (const role of dataRoles) {
    if (!validRoleSet.has(role)) {
      const message =
        validRoles.length > 0
          ? `role "${role}" is not defined for org "${orgSlug}". Valid roles: ${validRoles.join(", ")}`
          : `role "${role}" is not defined for org "${orgSlug}" — no app in this org defines any roles`;
      throw new InviteError("unknown_role", message);
    }
  }

  // 3. Invite, or — if this email is already a user — find them instead.
  const { userId, alreadyExisted } = await inviteOrFindUser(supabase, email);

  // 4. Upsert the membership row. For someone who is already a member, a
  // requested admin role goes through `set_membership_admin_role`, the same
  // locked database function the members page uses, so re-inviting the last
  // org_admin as a member cannot leave the org with no administrator.
  const { data: existing, error: existingErr } = await supabase
    .from("memberships")
    .select("admin_role")
    .eq("user_id", userId)
    .eq("org_id", orgRow.id)
    .maybeSingle();
  if (existingErr) {
    throw new InviteError("db_error", `error reading membership row: ${existingErr.message}`);
  }
  const current = (existing as { admin_role: AdminRole } | null)?.admin_role ?? null;
  if (current && adminRole && current !== adminRole) {
    const { data: result, error: roleErr } = await supabase.rpc("set_membership_admin_role", {
      p_org_id: orgRow.id,
      p_user_id: userId,
      p_admin_role: adminRole,
    });
    if (roleErr) throw new InviteError("db_error", `error setting admin role: ${roleErr.message}`);
    if (result === "last_admin") {
      throw new InviteError("last_admin", `re-inviting would leave org "${orgSlug}" with no org_admin`);
    }
    if (result !== "ok") throw new InviteError("db_error", `unexpected set_membership_admin_role result: ${String(result)}`);
  }

  const { error: membershipErr } = await supabase.from("memberships").upsert(
    {
      user_id: userId,
      org_id: orgRow.id,
      // Only on a NEW membership — see the note on `adminRole` above, and the
      // existing-member branch just before this. A key absent from the
      // payload is not updated on conflict; a key present as `undefined`
      // would be.
      ...(adminRole && !current ? { admin_role: adminRole } : {}),
      invited_by: invitedBy,
      invited_at: new Date().toISOString(),
    },
    { onConflict: "user_id,org_id" },
  );
  if (membershipErr) {
    throw new InviteError("db_error", `error writing membership row: ${membershipErr.message}`);
  }

  // 5. Upsert one role_assignments row per data role. Primary key is
  // (user_id, org_id, role) with no updatable columns beyond that, so this is
  // an upsert-as-insert-if-absent: re-running for the same triple must not
  // error.
  for (const role of dataRoles) {
    const { error: roleErr } = await supabase.from("role_assignments").upsert(
      { user_id: userId, org_id: orgRow.id, role },
      { onConflict: "user_id,org_id,role", ignoreDuplicates: true },
    );
    if (roleErr) {
      throw new InviteError("db_error", `error writing role assignment row: ${roleErr.message}`);
    }
  }

  return {
    userId,
    email,
    orgSlug,
    adminRole: adminRole ?? null,
    dataRoles,
    alreadyExisted,
  };
}
