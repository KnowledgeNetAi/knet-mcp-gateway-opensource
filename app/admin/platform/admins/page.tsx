import { requireSuperAdmin } from "@/lib/authz/viewer";
import { createAdminClient } from "@/lib/supabase/admin";
import { AdminFrame, AdminPanel, AdminField, AdminSubmit, AdminNotice } from "@/components/admin/frame";
import { AdminTable } from "@/components/admin/table";
import { ConfirmSubmit } from "@/components/admin/confirm";
import { grantSuperAdminAction, revokeSuperAdminAction } from "./actions";

type SearchParams = Promise<{ error?: string }>;

const ERRORS: Record<string, { label: string; detail: string }> = {
  unconfirmed: {
    label: "Invitation not accepted",
    detail: "That person has not accepted their invitation yet. Grant super admin after they have signed in once.",
  },
  no_such_user: {
    label: "No account found",
    detail: "That email has no account yet. Invite them first, then grant super admin.",
  },
  last_super_admin: {
    label: "Can't do that",
    detail: "You are the only platform administrator. Grant another before revoking this one.",
  },
  db_error: {
    label: "Something went wrong",
    detail: "The change was not saved. Try again.",
  },
};

interface PlatformAdminRow {
  userId: string;
  email: string | null;
  grantedBy: string | null;
  grantedByEmail: string | null;
  grantedAt: string;
}

/**
 * Reads `platform_admins`, then resolves every relevant email — the admin's
 * own and whoever granted them — through one `listUsers` page. supabase-js
 * has no admin get-by-id-list call; `lib/admin/members.ts`'s `listMembers`
 * does the same thing for org members, for the same reason.
 */
async function listPlatformAdmins(): Promise<PlatformAdminRow[]> {
  const supabase = createAdminClient();

  const { data: rows, error } = await supabase
    .from("platform_admins")
    .select("user_id, granted_by, granted_at")
    .order("granted_at", { ascending: true });
  if (error) {
    throw new Error(`error listing platform admins: ${error.message}`);
  }

  const { data: page, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) {
    throw new Error(`error listing auth users: ${listErr.message}`);
  }
  const emailById = new Map(
    (page?.users ?? []).map((u: { id: string; email?: string }) => [u.id, u.email ?? null]),
  );

  return (
    (rows ?? []) as Array<{ user_id: string; granted_by: string | null; granted_at: string }>
  ).map((row) => ({
    userId: row.user_id,
    email: emailById.get(row.user_id) ?? null,
    grantedBy: row.granted_by,
    grantedByEmail: row.granted_by ? (emailById.get(row.granted_by) ?? null) : null,
    grantedAt: row.granted_at,
  }));
}

/**
 * `/admin/platform/admins`. Super-admin-only — checked here for the page
 * render, and again, independently, inside both `grantSuperAdminAction` and
 * `revokeSuperAdminAction` (Global Constraints).
 */
export default async function PlatformAdminsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const error = sp.error ? ERRORS[sp.error] : null;

  const admins = await listPlatformAdmins();

  return (
    <AdminFrame
      eyebrow="Platform / Admins"
      title="Platform administrators"
      lede={`${admins.length} platform administrator${admins.length === 1 ? "" : "s"}`}
    >
      {error && (
        <AdminNotice tone="error" label={error.label}>
          {error.detail}
        </AdminNotice>
      )}

      <AdminTable title="Super admins" count={admins.length} columns={["Email", "Granted by", "Granted", "Actions"]}>
        {admins.map((admin) => (
          <tr key={admin.userId}>
            <td>{admin.email ?? admin.userId}</td>
            <td className="admin-muted">{admin.grantedByEmail ?? admin.grantedBy ?? "—"}</td>
            <td className="admin-nowrap">
              {new Date(admin.grantedAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </td>
            <td>
              <form action={revokeSuperAdminAction}>
                <input type="hidden" name="userId" value={admin.userId} />
                <ConfirmSubmit title={`Revoke super admin from ${admin.email ?? "this admin"}`}>Revoke</ConfirmSubmit>
              </form>
            </td>
          </tr>
        ))}
      </AdminTable>

      <AdminPanel>
        <form action={grantSuperAdminAction} className="admin-form">
          <AdminField
            label="Email"
            name="email"
            type="email"
            required
            placeholder="person@example.com"
          />
          <AdminSubmit>Grant super admin</AdminSubmit>
        </form>
      </AdminPanel>
    </AdminFrame>
  );
}
