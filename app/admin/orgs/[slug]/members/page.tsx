import { requireOrgAdmin } from "@/lib/authz/viewer";
import { listMembers } from "@/lib/admin/members";
import { validRolesForOrg } from "@/lib/admin/invite";
import { AdminFrame, AdminPanel, AdminField, AdminSubmit, AdminNotice } from "@/components/admin/frame";
import { AdminTable } from "@/components/admin/table";
import { ConfirmSubmit } from "@/components/admin/confirm";
import { readOneShotSecret } from "@/lib/admin/one-shot";
import {
  inviteAction,
  setAdminRoleAction,
  setDataRolesAction,
  removeMemberAction,
  copyInviteLinkAction,
  resendInviteAction,
} from "./actions";
import { OrgNav } from "@/components/admin/org-nav";

type Params = Promise<{ slug: string }>;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
type SearchParams = Promise<{ error?: string; notice?: string }>;

const ERRORS: Record<string, { label: string; detail: string }> = {
  no_such_org: {
    label: "Organization not found",
    detail: "This organization no longer exists.",
  },
  unknown_role: {
    label: "Unknown role",
    detail: "One of the selected data roles is not defined by any app in this org's committed roles.json.",
  },
  invite_failed: {
    label: "Invite failed",
    detail: "The invite email could not be sent. Try again.",
  },
  db_error: {
    label: "Something went wrong",
    detail: "The change was not saved. Try again.",
  },
  last_admin: {
    label: "Can't do that",
    detail: "This is the last administrator of this organization. Promote someone else first.",
  },
  not_a_member: {
    label: "Not a member",
    detail: "That person is not a member of this organization.",
  },
  invalid_admin_role: {
    label: "Invalid role",
    detail: "Choose either member or org_admin.",
  },
  beyond_org: {
    label: "Ask a super admin",
    detail: "This person also has access outside this organization, so only a super admin can copy their sign-in link. Re-send the invite email instead.",
  },
  link_failed: {
    label: "Could not generate invite link",
    detail: "Try again, or invite the address again from the form below.",
  },
  resend_failed: {
    label: "Could not resend",
    detail: "Neither the invite nor the password-reset email could be sent.",
  },
};

const NOTICES: Record<string, { label: string; detail: string }> = {
  invite_sent: {
    label: "Invitation handed off",
    detail: "Supabase Auth accepted the invitation for email delivery. The status stays pending until the recipient confirms it.",
  },
  member_updated: {
    label: "Existing member updated",
    detail: "That email already had an account, so no new invitation was sent. Their organization roles were updated.",
  },
  invite_resent: {
    label: "Invite resent",
    detail: "A fresh invite email is on its way. The previous link still works until it expires.",
  },
  // The person had already accepted their invite, so a second invite would be
  // the wrong mail to send. A password reset lands them on the same
  // /set-password page through the same click-to-confirm step.
  reset_sent: {
    label: "Password reset sent",
    detail:
      "This person had already accepted their invite, so they were sent a password reset instead — it reaches the same place.",
  },
};

/**
 * `/admin/orgs/[slug]/members`. `requireOrgAdmin` gates the page render;
 * every Server Action below performs the identical check again on its own
 * (Global Constraints — a Server Action is a public POST endpoint).
 */
export default async function MembersPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { slug } = await params;
  const { org } = await requireOrgAdmin(slug);
  const sp = await searchParams;
  const inviteLink = await readOneShotSecret("kngw_invite_link");
  const error = sp.error ? ERRORS[sp.error] : null;
  const notice = sp.notice ? NOTICES[sp.notice] : null;

  const members = await listMembers(org.id);
  const dataRoles = validRolesForOrg(slug);

  return (
    <AdminFrame
      eyebrow={`Organizations / ${org.slug} / Members`}
      title="Members"
      lede={`${members.length} member${members.length === 1 ? "" : "s"}`}
    >
      <OrgNav slug={slug} />
      {error && (
        <AdminNotice tone="error" label={error.label}>
          {error.detail}
        </AdminNotice>
      )}

      {notice && (
        <AdminNotice tone="ok" label={notice.label}>
          {notice.detail}
        </AdminNotice>
      )}

      {inviteLink && (
        <AdminNotice tone="ok" label="Invite link">
          Copy this now and send it to the invitee — it will not be shown again.
          <p className="admin-empty">
            <code>{inviteLink}</code>
          </p>
        </AdminNotice>
      )}

      <AdminNotice label="How invitation status works">
        “Invite pending” means the recipient has not confirmed the invitation. “Accepted” means the email was confirmed; last sign-in shows whether they have subsequently used this gateway. Email-provider delivery and bounce telemetry is not currently stored here.
      </AdminNotice>

      <AdminTable
        title="People"
        count={members.length}
        columns={["Email", "Status", "Admin role", "Data roles", "Invited", "Last sign-in", "Actions"]}
      >
        {members.map((member) => (
          <tr key={member.userId}>
            <td>{member.email ?? member.userId}</td>
            <td><span className={`admin-badge ${member.pending ? "admin-badge-warn" : "admin-badge-ok"}`}>{member.pending ? "Invite pending" : "Accepted"}</span></td>
            <td>
              <form action={setAdminRoleAction} className="admin-actions">
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="userId" value={member.userId} />
                <select
                  name="adminRole"
                  defaultValue={member.adminRole}
                  className="admin-select"
                  aria-label={`Admin role for ${member.email ?? "member"}`}
                >
                  <option value="member">member</option>
                  <option value="org_admin">org_admin</option>
                </select>
                <button type="submit" className="admin-btn">
                  Save
                </button>
              </form>
            </td>
            <td>
              <form action={setDataRolesAction} className="admin-actions">
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="userId" value={member.userId} />
                {dataRoles.length === 0 ? (
                  <span className="admin-muted">none defined</span>
                ) : (
                  <>
                    {dataRoles.map((role) => (
                      <label key={role} className="admin-toggle">
                        <input
                          type="checkbox"
                          name="dataRoles"
                          value={role}
                          defaultChecked={member.dataRoles.includes(role)}
                        />
                        {role}
                      </label>
                    ))}
                    <button type="submit" className="admin-btn">
                      Save
                    </button>
                  </>
                )}
              </form>
            </td>
            <td className="admin-date-stack">
              <span>{member.invitedAt ? formatDate(member.invitedAt) : "—"}</span>
              <small>{member.acceptedAt ? `Accepted ${formatDate(member.acceptedAt)}` : "Not accepted"}</small>
            </td>
            <td className={member.lastSignInAt ? "admin-nowrap" : "admin-nowrap admin-muted"}>
              {member.lastSignInAt ? formatDate(member.lastSignInAt) : "Never"}
            </td>
            <td>
              <div className="admin-actions">
                <form action={resendInviteAction}>
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="email" value={member.email ?? ""} />
                  <button type="submit" className="admin-btn" disabled={!member.email} title="Resend the invite (or a password reset, if already accepted)">
                    Resend
                  </button>
                </form>
                <form action={copyInviteLinkAction}>
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="email" value={member.email ?? ""} />
                  <button type="submit" className="admin-btn" disabled={!member.email}>
                    Copy link
                  </button>
                </form>
                <form action={removeMemberAction}>
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="userId" value={member.userId} />
                  <ConfirmSubmit title={`Remove ${member.email ?? "this member"} from ${org.name}`}>Remove</ConfirmSubmit>
                </form>
              </div>
            </td>
          </tr>
        ))}
      </AdminTable>

      <AdminPanel>
        <h2 className="admin-section-title">Invite a member</h2>
        <form action={inviteAction} className="admin-form">
          <input type="hidden" name="slug" value={slug} />
          <AdminField label="Email" name="email" type="email" required placeholder="person@example.com" />

          <fieldset className="admin-fieldset">
            <legend className="admin-field-label">Admin role</legend>
            <div className="admin-segmented">
              <label>
                <input type="radio" name="adminRole" value="member" defaultChecked />
                member
              </label>
              <label>
                <input type="radio" name="adminRole" value="org_admin" />
                org_admin
              </label>
            </div>
          </fieldset>

          <fieldset className="admin-fieldset">
            <legend className="admin-field-label">Data roles</legend>
            {dataRoles.length === 0 ? (
              <p className="admin-empty">
                No data roles are defined for this org yet — add one by committing{" "}
                <code>orgs/{slug}/&lt;app&gt;/roles.json</code>.
              </p>
            ) : (
              <div className="admin-actions">
                {dataRoles.map((role) => (
                  <label key={role} className="admin-toggle">
                    <input type="checkbox" name="dataRoles" value={role} />
                    {role}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <AdminSubmit>Invite</AdminSubmit>
        </form>
      </AdminPanel>
    </AdminFrame>
  );
}
