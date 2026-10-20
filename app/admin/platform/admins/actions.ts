"use server";

import { redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/authz/viewer";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAdminAudit } from "@/lib/admin/audit";

/**
 * Every action below starts with its own `requireSuperAdmin()` — a Server
 * Action is a public POST endpoint, and `app/admin/platform/admins/page.tsx`'s
 * own check (Global Constraints) does not cover it. `redirect()` is always
 * called OUTSIDE any try/catch: it signals by throwing, and a catch wrapped
 * around it would swallow that throw back up as if it were the wrapped
 * operation's own failure — same shape as
 * `app/admin/orgs/new/actions.ts` and `app/admin/orgs/[slug]/members/actions.ts`.
 *
 * These are platform-level actions, not scoped to any organization, so every
 * `writeAdminAudit` call below passes `orgId: null`.
 */

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * The platform's current super-admin user ids. The only reader of
 * `platform_admins` used to decide whether a revoke would leave the platform
 * with none — mirrors `lib/admin/members.ts`'s `orgAdminUserIds`: kept as the
 * one place this count is read so the last-admin rule cannot drift if a
 * second call site is ever added.
 */
async function superAdminUserIds(supabase: AdminClient): Promise<string[]> {
  const { data, error } = await supabase.from("platform_admins").select("user_id");
  if (error) {
    throw new Error(`error counting platform admins: ${error.message}`);
  }
  return ((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
}

/**
 * Grants super admin standing to the account with this email. The account
 * must already exist — supabase-js has no admin get-by-email call, so this
 * paginates `listUsers` and matches by email, the same constraint
 * `lib/admin/invite.ts` documents. Failing to find a match is a clean,
 * audited failure, not a crash.
 */
export async function grantSuperAdminAction(formData: FormData) {
  const viewer = await requireSuperAdmin();
  const email = String(formData.get("email") ?? "").trim();
  const supabase = createAdminClient();

  const { data: page, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const user = listErr
    ? null
    : (page.users.find(
        (u: { id: string; email?: string }) => u.email?.toLowerCase() === email.toLowerCase(),
      ) ?? null);

  if (!user) {
    await writeAdminAudit({
      viewer,
      orgId: null,
      action: "superadmin.grant",
      target: email,
      detail: { reason: "no_such_user" },
      outcome: "error",
    });
    redirect(`/admin/platform/admins?error=no_such_user`);
  }

  const { error: upsertErr } = await supabase
    .from("platform_admins")
    .upsert({ user_id: user.id, granted_by: viewer.userId }, { onConflict: "user_id" });

  if (upsertErr) {
    await writeAdminAudit({
      viewer,
      orgId: null,
      action: "superadmin.grant",
      target: email,
      detail: { reason: "db_error" },
      outcome: "error",
    });
    redirect(`/admin/platform/admins?error=db_error`);
  }

  await writeAdminAudit({
    viewer,
    orgId: null,
    action: "superadmin.grant",
    target: email,
    detail: { userId: user.id },
    outcome: "ok",
  });
  redirect("/admin/platform/admins");
}

/**
 * Revokes super admin standing from a user id. The last remaining super
 * admin can never be revoked — enforced here via `superAdminUserIds`, not by
 * hiding the button (mirrors `lib/admin/members.ts`'s last-admin
 * protection for `org_admin`).
 */
export async function revokeSuperAdminAction(formData: FormData) {
  const viewer = await requireSuperAdmin();
  const userId = String(formData.get("userId") ?? "");
  const supabase = createAdminClient();

  const admins = await superAdminUserIds(supabase);
  if (admins.length === 1 && admins[0] === userId) {
    await writeAdminAudit({
      viewer,
      orgId: null,
      action: "superadmin.revoke",
      target: userId,
      detail: { reason: "last_super_admin" },
      outcome: "denied",
    });
    redirect(`/admin/platform/admins?error=last_super_admin`);
  }

  const { error } = await supabase.from("platform_admins").delete().eq("user_id", userId);
  if (error) {
    await writeAdminAudit({
      viewer,
      orgId: null,
      action: "superadmin.revoke",
      target: userId,
      detail: { reason: "db_error" },
      outcome: "error",
    });
    redirect(`/admin/platform/admins?error=db_error`);
  }

  await writeAdminAudit({
    viewer,
    orgId: null,
    action: "superadmin.revoke",
    target: userId,
    outcome: "ok",
  });
  redirect("/admin/platform/admins");
}
