"use server";

import { redirect } from "next/navigation";
import { emailLinkOrigin } from "@/lib/http/origin";
import { setOneShotSecret } from "@/lib/admin/one-shot";
import { requireOrgAdmin } from "@/lib/authz/viewer";
import type { AdminRole } from "@/lib/authz/viewer";
import { inviteMember, InviteError, validRolesForOrg } from "@/lib/admin/invite";
import { setAdminRole, setDataRoles, removeMember, memberForLink, MemberError } from "@/lib/admin/members";
import { writeAdminAudit } from "@/lib/admin/audit";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Every action below starts with its own `requireOrgAdmin(slug)` — a Server
 * Action is a public POST endpoint, and the page's own check (Global
 * Constraints) does not cover it. `redirect()` is always called OUTSIDE any
 * try/catch: it signals by throwing, and a catch wrapped around it would
 * swallow that throw back up as if it were the wrapped operation's own
 * failure (mirrors `app/admin/orgs/new/actions.ts`).
 */

function isAdminRole(value: FormDataEntryValue | null): value is AdminRole {
  return value === "org_admin" || value === "member";
}

function requestedDataRoles(formData: FormData, slug: string): string[] {
  const valid = new Set(validRolesForOrg(slug));
  return formData
    .getAll("dataRoles")
    .map(String)
    .filter((role) => valid.has(role));
}

/**
 * Invites a new member (or re-invites an existing user idempotently), with
 * an admin role explicitly chosen in the form — unlike `scripts/invite.ts`,
 * which omits `adminRole` entirely so a re-run never demotes an existing
 * org_admin. Here the operator is deliberately setting the role, so it is
 * always passed.
 */
export async function inviteAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const { viewer, org } = await requireOrgAdmin(slug);

  const email = String(formData.get("email") ?? "").trim();
  const adminRoleField = formData.get("adminRole");
  const adminRole: AdminRole = isAdminRole(adminRoleField) ? adminRoleField : "member";
  const dataRoles = requestedDataRoles(formData, slug);

  let failure: InviteError["reason"] | null = null;
  let alreadyExisted = false;

  try {
    const result = await inviteMember({ orgSlug: slug, email, adminRole, dataRoles, invitedBy: viewer.userId });
    alreadyExisted = result.alreadyExisted;
  } catch (e) {
    if (!(e instanceof InviteError)) throw e;
    failure = e.reason;
  }

  if (failure) {
    await writeAdminAudit({
      viewer,
      orgId: org.id,
      action: "member.invite",
      target: email,
      detail: { reason: failure },
      outcome: "error",
    });
    redirect(`/admin/orgs/${slug}/members?error=${failure}`);
  }

  await writeAdminAudit({
    viewer,
    orgId: org.id,
    action: "member.invite",
    target: email,
    detail: { adminRole, dataRoles },
    outcome: "ok",
  });
  redirect(`/admin/orgs/${slug}/members?notice=${alreadyExisted ? "member_updated" : "invite_sent"}`);
}

/** Sets the org-scoped platform role (`org_admin`/`member`) for one member. */
export async function setAdminRoleAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const { viewer, org } = await requireOrgAdmin(slug);

  const userId = String(formData.get("userId") ?? "");
  const adminRoleField = formData.get("adminRole");

  if (!isAdminRole(adminRoleField)) {
    await writeAdminAudit({
      viewer,
      orgId: org.id,
      action: "member.admin_role",
      target: userId,
      detail: { reason: "invalid_admin_role" },
      outcome: "error",
    });
    redirect(`/admin/orgs/${slug}/members?error=invalid_admin_role`);
  }

  let failure: MemberError["reason"] | null = null;
  try {
    await setAdminRole(org.id, userId, adminRoleField);
  } catch (e) {
    if (!(e instanceof MemberError)) throw e;
    failure = e.reason;
  }

  if (failure) {
    await writeAdminAudit({
      viewer,
      orgId: org.id,
      action: "member.admin_role",
      target: userId,
      detail: { reason: failure },
      outcome: failure === "last_admin" ? "denied" : "error",
    });
    redirect(`/admin/orgs/${slug}/members?error=${failure}`);
  }

  await writeAdminAudit({
    viewer,
    orgId: org.id,
    action: "member.admin_role",
    target: userId,
    detail: { adminRole: adminRoleField },
    outcome: "ok",
  });
  redirect(`/admin/orgs/${slug}/members`);
}

/** Reconciles a member's git-defined data-access roles (`role_assignments`). */
export async function setDataRolesAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const { viewer, org } = await requireOrgAdmin(slug);

  const userId = String(formData.get("userId") ?? "");
  const dataRoles = requestedDataRoles(formData, slug);

  let failure: MemberError["reason"] | null = null;
  try {
    await setDataRoles(org.id, slug, userId, dataRoles);
  } catch (e) {
    if (!(e instanceof MemberError)) throw e;
    failure = e.reason;
  }

  if (failure) {
    await writeAdminAudit({
      viewer,
      orgId: org.id,
      action: "role.assign",
      target: userId,
      detail: { reason: failure, dataRoles },
      outcome: "error",
    });
    redirect(`/admin/orgs/${slug}/members?error=${failure}`);
  }

  await writeAdminAudit({
    viewer,
    orgId: org.id,
    action: "role.assign",
    target: userId,
    detail: { dataRoles },
    outcome: "ok",
  });
  redirect(`/admin/orgs/${slug}/members`);
}

/**
 * Removes a member: revokes their live API keys, then deletes their
 * `role_assignments` and `memberships` rows (`lib/admin/members.ts`, spec
 * §5). The org's last `org_admin` cannot be removed — `MemberError`'s
 * `last_admin` reason is surfaced as a plain, specific notice rather than a
 * generic failure message.
 */
export async function removeMemberAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const { viewer, org } = await requireOrgAdmin(slug);

  const userId = String(formData.get("userId") ?? "");

  let failure: MemberError["reason"] | null = null;
  try {
    await removeMember(org.id, userId);
  } catch (e) {
    if (!(e instanceof MemberError)) throw e;
    failure = e.reason;
  }

  if (failure) {
    await writeAdminAudit({
      viewer,
      orgId: org.id,
      action: "member.remove",
      target: userId,
      detail: { reason: failure },
      outcome: failure === "last_admin" ? "denied" : "error",
    });
    redirect(`/admin/orgs/${slug}/members?error=${failure}`);
  }

  await writeAdminAudit({
    viewer,
    orgId: org.id,
    action: "member.remove",
    target: userId,
    outcome: "ok",
  });
  redirect(`/admin/orgs/${slug}/members`);
}


/**
 * Re-sends an invite email. This is the pattern the reference implementation uses in
 * production (`app/users/actions.ts`'s `resendInviteAction`), adopted here
 * rather than re-derived:
 *
 *   1. Call `inviteUserByEmail` again. Contrary to what the phase 3 spec
 *      assumed, this DOES work for a PENDING user — one invited but not yet
 *      accepted. `email_exists` comes back only once the account is fully
 *      registered, which is not the case for someone who never set a
 *      password.
 *   2. If it does error, the person has already accepted, so an invite is
 *      the wrong mail to send them anyway. Fall back to
 *      `resetPasswordForEmail`, which lands on `/set-password` through the
 *      same `/auth/confirm` click-to-confirm page — the recipient reaches
 *      the place they needed either way.
 *
 * `redirectTo` is passed explicitly rather than relying on the dashboard
 * template's `{{ .SiteURL }}`, so the link points at the origin serving this
 * request instead of whatever `site_url` was last set to.
 */
export async function resendInviteAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const { viewer, org } = await requireOrgAdmin(slug);

  const email = String(formData.get("email") ?? "").trim();
  if (!(await memberForLink(org.id, email))) {
    await writeAdminAudit({
      viewer,
      orgId: org.id,
      action: "member.invite",
      target: email,
      detail: { reason: "not_a_member", resent: true },
      outcome: "denied",
    });
    redirect(`/admin/orgs/${slug}/members?error=not_a_member`);
  }
  const redirectTo = `${await emailLinkOrigin()}/auth/confirm?next=/set-password`;

  const supabase = createAdminClient();
  const { error } = await supabase.auth.admin.inviteUserByEmail(email, { redirectTo });

  let notice = "invite_resent";
  if (error) {
    const { error: recoveryError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    });
    if (recoveryError) {
      await writeAdminAudit({
        viewer,
        orgId: org.id,
        action: "member.invite",
        target: email,
        detail: { reason: "resend_failed", inviteError: error.message },
        outcome: "error",
      });
      redirect(`/admin/orgs/${slug}/members?error=resend_failed`);
    }
    notice = "reset_sent";
  }

  await writeAdminAudit({
    viewer,
    orgId: org.id,
    action: "member.invite",
    target: email,
    detail: { resent: true, fallback: notice === "reset_sent" ? "recovery" : null },
    outcome: "ok",
  });
  redirect(`/admin/orgs/${slug}/members?notice=${notice}`);
}

/**
 * Copies an invite link without sending anything — for handing someone their
 * link over Slack or in person, or when mail delivery is in doubt. The
 * ordinary resend path is `resendInviteAction` below. The link is never
 * persisted: it comes back in a one-shot query param that the page renders
 * once, in a selectable `<code>` block, and is gone on the next navigation.
 */
export async function copyInviteLinkAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const { viewer, org } = await requireOrgAdmin(slug);

  const email = String(formData.get("email") ?? "").trim();
  // The link signs whoever opens it in as `email`, and it is shown to the
  // acting admin. Only a member of this org qualifies, and only a super admin
  // may copy the link of someone whose account reaches beyond this org.
  const target = await memberForLink(org.id, email);
  const refusal = !target ? "not_a_member" : target.beyondOrg && !viewer.isSuperAdmin ? "beyond_org" : null;
  if (refusal) {
    await writeAdminAudit({
      viewer,
      orgId: org.id,
      action: "member.invite",
      target: email,
      detail: { reason: refusal, copiedLink: true },
      outcome: "denied",
    });
    redirect(`/admin/orgs/${slug}/members?error=${refusal}`);
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase.auth.admin.generateLink({ type: "invite", email });
  const link = data?.properties?.action_link ?? null;

  if (error || !link) {
    await writeAdminAudit({
      viewer,
      orgId: org.id,
      action: "member.invite",
      target: email,
      detail: { reason: "generate_link_failed" },
      outcome: "error",
    });
    redirect(`/admin/orgs/${slug}/members?error=link_failed`);
  }

  await writeAdminAudit({
    viewer,
    orgId: org.id,
    action: "member.invite",
    target: email,
    detail: { copiedLink: true },
    outcome: "ok",
  });
  // Not a query parameter: this link carries a single-use credential that
  // grants a session, and a URL is recorded in access logs and history.
  // See lib/admin/one-shot.ts.
  await setOneShotSecret("kngw_invite_link", link, `/admin/orgs/${slug}/members`);
  redirect(`/admin/orgs/${slug}/members`);
}
