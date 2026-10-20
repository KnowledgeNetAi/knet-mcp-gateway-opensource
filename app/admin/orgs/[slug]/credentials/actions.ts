"use server";

import { redirect } from "next/navigation";
import { requireOrgAdmin } from "@/lib/authz/viewer";
import { writeCredential, testConnection } from "@/lib/admin/credentials";
import { writeAdminAudit } from "@/lib/admin/audit";

/**
 * Every action below starts with its own `requireOrgAdmin(slug)` — a Server
 * Action is a public POST endpoint, and the page's own check (Global
 * Constraints) does not cover it. `redirect()` is always called OUTSIDE any
 * try/catch: it signals by throwing, and a catch wrapped around it would
 * swallow that throw back up as if it were the wrapped operation's own
 * failure (mirrors `app/admin/orgs/new/actions.ts` and
 * `app/admin/orgs/[slug]/members/actions.ts`).
 *
 * Neither action ever puts a credential VALUE into `writeAdminAudit`'s
 * `detail` — only `vaultName`/`app`, which are names, not secrets.
 */

/**
 * Writes one credential field. The submitted value never round-trips back
 * to the browser in any form — on success this redirects to the same page,
 * which re-renders every field from `credentialFieldsFor` (isSet/updatedAt
 * only); on failure it redirects with an error code, never the value itself.
 */
export async function writeCredentialAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const vaultName = String(formData.get("vaultName") ?? "");
  const value = String(formData.get("value") ?? "");
  const { viewer, org } = await requireOrgAdmin(slug);

  if (!value) {
    await writeAdminAudit({
      viewer,
      orgId: org.id,
      action: "credential.write",
      target: vaultName,
      detail: { key: vaultName, reason: "empty_value" },
      outcome: "denied",
    });
    redirect(`/admin/orgs/${slug}/credentials?error=empty_value`);
  }

  let failure: "cross_org" | "write_failed" | null = null;
  try {
    await writeCredential(vaultName, value, { orgSlug: slug });
  } catch (e) {
    failure = e instanceof Error && /does not belong/.test(e.message) ? "cross_org" : "write_failed";
  }

  if (failure) {
    await writeAdminAudit({
      viewer,
      orgId: org.id,
      action: "credential.write",
      target: vaultName,
      detail: { key: vaultName, reason: failure },
      outcome: failure === "cross_org" ? "denied" : "error",
    });
    redirect(`/admin/orgs/${slug}/credentials?error=${failure}`);
  }

  await writeAdminAudit({
    viewer,
    orgId: org.id,
    action: "credential.write",
    target: vaultName,
    detail: { key: vaultName },
    outcome: "ok",
  });
  redirect(`/admin/orgs/${slug}/credentials?saved=${encodeURIComponent(vaultName)}`);
}

/**
 * Mints an upstream token through `testConnection` and reports the outcome
 * via the query string — pass/fail plus an HTTP status only (`testConnection`
 * itself never returns the upstream response body; see
 * `lib/admin/credentials.ts`). The audit `detail` carries that same
 * pass/fail summary, never a token or any other response content.
 */
export async function testConnectionAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const app = String(formData.get("app") ?? "");
  const { viewer, org } = await requireOrgAdmin(slug);

  const result = await testConnection(slug, app);

  await writeAdminAudit({
    viewer,
    orgId: org.id,
    action: "credential.test",
    target: app,
    detail: result.ok ? { app } : { app, reason: result.detail },
    outcome: result.ok ? "ok" : "error",
  });

  const qs = result.ok
    ? `tested=${encodeURIComponent(app)}&ok=1`
    : `tested=${encodeURIComponent(app)}&ok=0&detail=${encodeURIComponent(result.detail)}`;
  redirect(`/admin/orgs/${slug}/credentials?${qs}`);
}
