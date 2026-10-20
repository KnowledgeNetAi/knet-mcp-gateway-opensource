import { requireOrgAdmin } from "@/lib/authz/viewer";
import { listKeys } from "@/lib/admin/keys";
import { AdminFrame, AdminPanel, AdminField, AdminSubmit, AdminNotice } from "@/components/admin/frame";
import { AdminTable } from "@/components/admin/table";
import { OrgNav } from "@/components/admin/org-nav";
import { ConfirmSubmit } from "@/components/admin/confirm";
import { readOneShotSecret } from "@/lib/admin/one-shot";
import { CopyField } from "@/components/copy-field";
import { originFromHeaders } from "@/lib/http/origin";
import { issueKeyAction, revokeKeyAction } from "./actions";

type Params = Promise<{ slug: string }>;

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * `/admin/orgs/[slug]/keys`. `requireOrgAdmin` gates the page render; every
 * Server Action below performs the identical check again on its own
 * (Global Constraints — a Server Action is a public POST endpoint).
 *
 * The full key minted by `issueKeyAction` arrives here once, through a
 * short-lived httpOnly cookie (`lib/admin/one-shot.ts`) — deliberately NOT a
 * query parameter, which would write the raw key into Cloud Run's access log,
 * the browser's history, and the `Referer` of the next click. Hashing keys at
 * rest is worth nothing if the plaintext is logged on the way out. Rendered in
 * a single `AdminNotice` and nowhere else.
 */
export default async function KeysPage({ params }: { params: Params }) {
  const { slug } = await params;
  const { org } = await requireOrgAdmin(slug);
  const issuedKey = await readOneShotSecret("kngw_issued_key");
  const origin = await originFromHeaders();

  const keys = await listKeys(org.id);

  return (
    <AdminFrame
      eyebrow={`Organizations / ${org.slug} / API keys`}
      title="API keys"
      lede={`${keys.length} active key${keys.length === 1 ? "" : "s"}`}
    >
      <OrgNav slug={slug} />
      {issuedKey && (
        <AdminNotice tone="ok" label="Copy this now — it is not shown again.">
          <CopyField label="API key" value={issuedKey} />
          <CopyField label="Claude Code" value={`claude mcp add --transport http ${org.slug} ${origin}/mcp/${org.slug} --header "X-API-Key: ${issuedKey}"`} />
        </AdminNotice>
      )}

      <CopyField label="MCP endpoint" value={`${origin}/mcp/${org.slug}`} />

      <AdminTable
        title="Active keys"
        count={keys.length}
        columns={["Prefix", "Label", "Source", "Issued to", "Created", "Last used", "Actions"]}
      >
        {keys.map((key) => (
          <tr key={key.id}>
            <td>
              <span className="admin-chip">{key.prefix}</span>
            </td>
            <td>{key.label ?? <span className="admin-muted">—</span>}</td>
            <td><span className={`admin-badge ${key.source === "oauth" ? "admin-badge-accent" : ""}`}>{key.source}</span></td>
            <td>{key.userEmail ?? <span className="admin-muted">—</span>}</td>
            <td className="admin-nowrap">{formatDate(key.createdAt)}</td>
            <td className={key.lastUsedAt ? "admin-nowrap" : "admin-nowrap admin-muted"}>{formatDate(key.lastUsedAt)}</td>
            <td>
              {/*
                Every key — manual or oauth — gets a revoke button. An
                oauth-sourced row (a phase 2 access/refresh token) is
                revocable here but is never reissued: it belongs to a
                consent flow, not to this page, so no "issue" control is
                offered per-row for any key, oauth or manual.
              */}
              <form action={revokeKeyAction}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="keyId" value={key.id} />
                <input type="hidden" name="prefix" value={key.prefix} />
                <ConfirmSubmit title={`Revoke ${key.label ?? key.prefix}`}>Revoke</ConfirmSubmit>
              </form>
            </td>
          </tr>
        ))}
      </AdminTable>

      <AdminPanel>
        <form action={issueKeyAction} className="admin-form">
          <input type="hidden" name="slug" value={slug} />
          <AdminField
            label="Label"
            name="label"
            placeholder="laptop, CI, Zapier, …"
            hint="Helps you tell keys apart later — not shown to the API."
          />
          <AdminSubmit>Issue new key</AdminSubmit>
        </form>
      </AdminPanel>
    </AdminFrame>
  );
}
