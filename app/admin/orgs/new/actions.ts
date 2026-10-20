"use server";

import { redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/authz/viewer";
import { createOrg, OrgError } from "@/lib/admin/orgs";
import { writeAdminAudit } from "@/lib/admin/audit";

/**
 * Creates an organization. Super-admin-only, checked HERE — independently
 * of `app/admin/orgs/new/page.tsx`'s own check — because a Server Action is
 * a public POST endpoint (Global Constraints); a check in the page above it
 * is not a check.
 *
 * `redirect()` is never called from inside a try/catch around `createOrg`:
 * Next's `redirect()` works by throwing, and a catch block written around
 * the call that also contains the redirect would swallow that throw right
 * back up as if it were the operation's own failure. So the outcome is
 * resolved first, then exactly one `redirect()` fires, unconditionally,
 * after the `try` has already exited — same shape as this repo's other
 * Server Actions (e.g. `app/set-password/actions.ts`).
 */
export async function createOrgAction(formData: FormData) {
  const viewer = await requireSuperAdmin();
  const slug = String(formData.get("slug") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();

  let created: { id: string } | null = null;
  let failure: OrgError["reason"] | null = null;

  try {
    created = await createOrg({ slug, name });
  } catch (e) {
    if (!(e instanceof OrgError)) throw e;
    failure = e.reason;
  }

  if (failure) {
    await writeAdminAudit({
      viewer,
      orgId: null,
      action: "org.create",
      target: slug,
      detail: { reason: failure },
      outcome: "denied",
    });
    redirect(`/admin/orgs/new?error=${failure}`);
  }

  await writeAdminAudit({
    viewer,
    orgId: created!.id,
    action: "org.create",
    target: slug,
    outcome: "ok",
  });
  redirect(`/admin/orgs/${slug}`);
}
