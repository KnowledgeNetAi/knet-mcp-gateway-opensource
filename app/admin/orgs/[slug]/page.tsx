import Link from "next/link";
import { requireOrgMember } from "@/lib/authz/viewer";
import { orgOverview } from "@/lib/admin/orgs";
import { AdminFrame } from "@/components/admin/frame";
import { AdminTable } from "@/components/admin/table";
import { CopyField } from "@/components/copy-field";
import { originFromHeaders } from "@/lib/http/origin";
import { OrgNav } from "@/components/admin/org-nav";

type Params = Promise<{ slug: string }>;

/**
 * `/admin/orgs/[slug]`. Any member of the org (or a super admin) may view
 * it. The empty-apps state is where spec decision 4 (an org's apps live in
 * git, not the database) becomes visible to a person: rather than an empty
 * table, it says in plain words how to add one.
 */
export default async function OrgOverviewPage({ params }: { params: Params }) {
  const { slug } = await params;
  const { viewer, org } = await requireOrgMember(slug);
  const canAdmin = viewer.isSuperAdmin || org.adminRole === "org_admin";
  const overview = await orgOverview(slug);
  // Derived from the request, never hardcoded: the same value a custom domain
  // would produce, with no deploy-time configuration to drift.
  const origin = await originFromHeaders();

  return (
    <AdminFrame
      eyebrow={`Organizations / ${overview.slug}`}
      title={overview.name}
      lede={`${overview.memberCount} member${overview.memberCount === 1 ? "" : "s"} · ${overview.activeKeyCount} active key${overview.activeKeyCount === 1 ? "" : "s"}`}
    >
      <OrgNav slug={overview.slug} canAdmin={canAdmin} />

      <div className="admin-stat-grid">
        <article className="admin-stat-card"><span>Connected apps</span><strong>{overview.appCount}</strong><small>Git-managed integrations</small></article>
        <article className="admin-stat-card"><span>Members</span><strong>{overview.memberCount}</strong><small>People with org access</small></article>
        <article className="admin-stat-card"><span>Active keys</span><strong>{overview.activeKeyCount}</strong><small>Manual and OAuth credentials</small></article>
      </div>

      {overview.apps.length === 0 ? (
        <p className="admin-empty">
          No apps configured. An app is added by committing{" "}
          <code>orgs/{overview.slug}/&lt;app&gt;/api.json</code> and{" "}
          <code>orgs/{overview.slug}/&lt;app&gt;/roles.json</code> — this org's slug is
          filled in for you; <code>&lt;app&gt;</code> is the app you are onboarding.
        </p>
      ) : (
        <>
          <AdminTable title="Connected apps" count={overview.apps.length} columns={["App", { label: "Tools", align: "end" }, "Roles", "App-scoped endpoint"]}>
            {overview.apps.map((app) => (
              <tr key={app.app}>
                <td>
                  {canAdmin ? <Link className="admin-app-link" href={`/admin/orgs/${overview.slug}/apps/${app.app}`}>{app.displayName}<span>View access →</span></Link> : app.displayName}
                </td>
                <td className="admin-num">{app.toolCount}</td>
                <td>
                  <div className="admin-actions admin-actions-wrap">
                    {app.roles.map((role) => <span key={role} className="admin-badge admin-badge-accent">{role}</span>)}
                  </div>
                </td>
                <td>
                  <span className="admin-chip">{`/mcp/${overview.slug}/${app.app}`}</span>
                </td>
              </tr>
            ))}
          </AdminTable>

          <h2 className="admin-section-title">MCP endpoint</h2>
          <p className="admin-note">
            This is the URL to give this organization&rsquo;s users. It covers every
            app above; the app-scoped URLs in the table matter only when you want
            to point a client at one system rather than all of them.
          </p>
          <CopyField label="Endpoint" value={`${origin}/mcp/${overview.slug}`} />
        </>
      )}
    </AdminFrame>
  );
}
