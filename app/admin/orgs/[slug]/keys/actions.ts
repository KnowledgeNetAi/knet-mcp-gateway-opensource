"use server";

import { redirect } from "next/navigation";
import { setOneShotSecret } from "@/lib/admin/one-shot";
import { requireOrgAdmin } from "@/lib/authz/viewer";
import { issueKey, revokeKey } from "@/lib/admin/keys";
import { writeAdminAudit } from "@/lib/admin/audit";

/**
 * Mints a new manual API key for the org. Org-admin-only, checked HERE —
 * independently of `app/admin/orgs/[slug]/keys/page.tsx`'s own check —
 * because a Server Action is a public POST endpoint (Global Constraints); a
 * check in the page above it is not a check.
 *
 * The full key returned by `issueKey` is handed to the page through a
 * short-lived httpOnly cookie, never the query string.
 * so the page can render it exactly once — it is never written to a cookie,
 * a database column, or `writeAdminAudit`'s `detail` (which carries only the
 * prefix, never the secret half of the key).
 *
 * `redirect()` fires unconditionally after the `try` has already exited —
 * same shape as `app/admin/orgs/new/actions.ts`'s `createOrgAction` — so
 * Next's throw-to-redirect can never be mistaken for this action's own
 * failure.
 */
export async function issueKeyAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const { viewer, org } = await requireOrgAdmin(slug);
  const label = String(formData.get("label") ?? "").trim();

  const { key, prefix } = await issueKey({
    orgId: org.id,
    orgSlug: org.slug,
    userId: viewer.userId,
    label,
  });

  await writeAdminAudit({
    viewer,
    orgId: org.id,
    action: "apikey.issue",
    target: prefix,
    detail: { prefix },
    outcome: "ok",
  });

  // Never on the query string: that records the raw key in access logs and
  // browser history. See lib/admin/one-shot.ts.
  await setOneShotSecret("kngw_issued_key", key, `/admin/orgs/${org.slug}/keys`);
  redirect(`/admin/orgs/${org.slug}/keys`);
}

/**
 * Revokes a key. Org-admin-only, checked HERE, independently of the page.
 * `revokeKey` filters on both `id` and `org_id`, so submitting a `keyId`
 * from a different org (guessed, or copied from another tab) revokes
 * nothing rather than reaching across orgs.
 */
export async function revokeKeyAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const keyId = String(formData.get("keyId") ?? "");
  const prefix = String(formData.get("prefix") ?? "");
  const { viewer, org } = await requireOrgAdmin(slug);

  await revokeKey(org.id, keyId);

  await writeAdminAudit({
    viewer,
    orgId: org.id,
    action: "apikey.revoke",
    target: prefix,
    detail: { prefix },
    outcome: "ok",
  });

  redirect(`/admin/orgs/${org.slug}/keys`);
}
