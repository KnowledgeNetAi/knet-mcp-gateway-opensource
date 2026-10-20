import { notFound } from "next/navigation";
import { requireOrgAdmin } from "@/lib/authz/viewer";
import { appAccessDetail } from "@/lib/admin/apps";
import { AdminFrame } from "@/components/admin/frame";
import { AdminTable } from "@/components/admin/table";
import { OrgNav } from "@/components/admin/org-nav";

type Params = Promise<{ slug: string; app: string }>;

function accessLabel(fields: readonly string[]): string {
  if (fields.includes("*")) return "All fields";
  if (fields.length === 0) return "Tool only";
  return `${fields.length} field${fields.length === 1 ? "" : "s"}`;
}

export default async function AppAccessPage({ params }: { params: Params }) {
  const { slug, app } = await params;
  const { org } = await requireOrgAdmin(slug);
  const detail = appAccessDetail(slug, app);
  if (!detail) notFound();

  return (
    <AdminFrame
      eyebrow={`Organizations / ${org.slug} / Apps`}
      title={detail.displayName}
      lede={`${detail.tools.length} tools · ${detail.roles.length} data roles · ${detail.baseUrl}`}
    >
      <OrgNav slug={slug} />

      <section className="admin-section">
        <div className="admin-section-heading">
          <div>
            <span className="admin-kicker">Access model</span>
            <h2 className="admin-section-title">What each role means</h2>
          </div>
          <p className="admin-section-copy">Roles are additive. A person with multiple roles receives the combined access of all of them.</p>
        </div>
        <div className="admin-role-grid">
          {detail.roles.map((role) => (
            <article className="admin-role-card" key={role.name}>
              <span className="admin-badge admin-badge-accent">{role.name}</span>
              <strong>{role.toolCount} of {detail.tools.length} tools</strong>
              <span>{role.writeToolCount ? `${role.writeToolCount} write tools` : "Read-only access"}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="admin-section">
        <div className="admin-section-heading">
          <div>
            <span className="admin-kicker">Effective policy</span>
            <h2 className="admin-section-title">Tool access</h2>
          </div>
        </div>
        <AdminTable columns={["Tool", "Type", ...detail.roles.map((role) => role.name)]}>
          {detail.tools.map((tool) => (
            <tr key={tool.name}>
              <td className="admin-tool-cell">
                <code>{tool.name}</code>
                {tool.description && (
                  <details className="admin-tool-desc">
                    <summary>{tool.description}</summary>
                    <p>{tool.description}</p>
                  </details>
                )}
              </td>
              <td><span className={`admin-badge ${tool.write ? "admin-badge-warn" : ""}`}>{tool.write ? "Write" : tool.method}</span></td>
              {tool.roles.map((role) => (
                <td key={role.name}>
                  {role.granted ? (
                    <div className="admin-access-detail">
                      <span className="admin-access-yes">Allowed</span>
                      <span title={role.fields.join(", ")}>{accessLabel(role.fields)}</span>
                      {tool.write && role.writes.length > 0 && <span>{role.writes.length} writable fields</span>}
                    </div>
                  ) : <span className="admin-access-no">No access</span>}
                </td>
              ))}
            </tr>
          ))}
        </AdminTable>
      </section>
    </AdminFrame>
  );
}
