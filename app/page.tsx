import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/authz/viewer";
import { getCatalog } from "@/lib/mcp/catalog";
import { computeGrant } from "@/lib/policy/grants";
import { originFromHeaders } from "@/lib/http/origin";
import { viewerRolesByOrg } from "@/lib/home/access";
import { listPluginsForOrg } from "@/lib/plugins/catalog";
import { CopyField } from "@/components/copy-field";

export const dynamic = "force-dynamic";

/** Signed-in launch page: effective access, endpoints, and setup in one place. */
export default async function HomePage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");

  const origin = await originFromHeaders();
  const catalog = [...getCatalog().values()];
  const rolesByOrg = await viewerRolesByOrg(viewer.userId, viewer.orgs.map((org) => org.id));
  const orgs = viewer.orgs.map((org) => ({
    ...org,
    dataRoles: rolesByOrg.get(org.id) ?? [],
    plugins: listPluginsForOrg(org.slug),
    apps: catalog.filter((entry) => entry.org === org.slug).map((entry) => ({
      slug: entry.app,
      displayName: entry.config.displayName,
      toolCount: entry.config.tools.length,
      availableToolCount: computeGrant(
        rolesByOrg.get(org.id) ?? [], entry.roles, entry.config.tools,
      ).tools.size,
    })),
  }));
  const appCount = orgs.reduce((total, org) => total + org.apps.length, 0);
  const availableToolCount = orgs.reduce(
    (total, org) => total + org.apps.reduce((sum, app) => sum + app.availableToolCount, 0), 0,
  );
  const canAdmin = viewer.isSuperAdmin || viewer.orgs.some((org) => org.adminRole === "org_admin");

  return (
    <div className="home-shell">
      <header className="home-nav">
        <Link href="/" className="home-brand"><span className="admin-logo-mark">G</span><span>MCP Gateway</span></Link>
        <div className="home-account">
          <span>{viewer.email ?? "Signed-in account"}</span>
          {canAdmin && <Link href="/admin" className="home-nav-action">Admin console</Link>}
        </div>
      </header>

      <main className="home-main">
        <section className="home-hero">
          <div>
            <span className="home-kicker">Your workspace</span>
            <h1>Your tools, ready for Claude.</h1>
            <p>Connect once, then use the business systems and data your roles allow.</p>
          </div>
          <div className="home-summary" aria-label="Account summary">
            <div><strong>{orgs.length}</strong><span>Organizations</span></div>
            <div><strong>{appCount}</strong><span>Connected apps</span></div>
            <div><strong>{availableToolCount}</strong><span>Available tools</span></div>
          </div>
        </section>

        {orgs.length === 0 && (
          <section className="home-empty">
            <span className="home-empty-icon">◎</span>
            <h2>No organization yet</h2>
            <p>Your account is ready. An administrator needs to add you to an organization before you can connect tools.</p>
          </section>
        )}

        <div className="home-org-list">
          {orgs.map((org) => (
            <section className="home-org" key={org.id}>
              <header className="home-org-header">
                <div>
                  <span className="home-kicker">Organization</span>
                  <h2>{org.name}</h2>
                  <div className="home-badges">
                    <span className="admin-badge admin-badge-accent">{org.adminRole === "org_admin" ? "Organization admin" : "Member"}</span>
                    {org.dataRoles.map((role) => <span className="admin-badge" key={role}>{role}</span>)}
                    {org.dataRoles.length === 0 && <span className="admin-badge admin-badge-warn">No data role assigned</span>}
                  </div>
                </div>
                {org.adminRole === "org_admin" && <Link href={`/admin/orgs/${org.slug}`} className="home-text-link">Manage organization →</Link>}
              </header>

              {org.apps.length === 0 ? (
                <p className="home-muted">No apps are configured for this organization yet.</p>
              ) : (
                <>
                  <div className="home-app-grid">
                    {org.apps.map((app) => (
                      <article className="home-app" key={app.slug}>
                        <span className="home-app-icon">{app.displayName.slice(0, 1).toUpperCase()}</span>
                        <div><strong>{app.displayName}</strong><span>{app.availableToolCount} of {app.toolCount} tools available</span></div>
                        <i aria-hidden="true"><b style={{ width: `${app.toolCount ? (app.availableToolCount / app.toolCount) * 100 : 0}%` }} /></i>
                      </article>
                    ))}
                  </div>

                  <div className="home-connect">
                    <div className="home-connect-copy">
                      <span className="home-kicker">Connect</span>
                      <h3>Organization endpoint</h3>
                      <p>Use this one address to make every available app accessible to Claude.</p>
                    </div>
                    <CopyField label="MCP endpoint" value={`${origin}/mcp/${org.slug}`} />
                  </div>

                  {org.plugins.map((plugin) => (
                    <div className="home-connect home-plugin" key={plugin.name}>
                      <div className="home-connect-copy">
                        <span className="home-kicker">Claude plugin · v{plugin.version}</span>
                        <h3>{plugin.displayName}</h3>
                        <p>{plugin.description}</p>
                      </div>
                      <div className="home-plugin-steps">
                        <a className="home-nav-action" href={`/plugins/${org.slug}/${plugin.name}`} download>Download plugin</a>
                        <ol>
                          <li>In claude.ai, open Customize → Plugins → Add → Upload plugin, and choose the zip.</li>
                          <li>Open the plugin’s Connectors tab and click the connector.</li>
                          <li>Sign in here when asked, and approve access.</li>
                        </ol>
                      </div>
                    </div>
                  ))}

                  <details className="home-setup">
                    <summary>Setup instructions</summary>
                    <div className="home-setup-grid">
                      <div><span>01</span><h3>Claude Desktop or web</h3><p>Add the endpoint as a custom connector. You’ll return here to sign in and approve the requested access.</p></div>
                      <div><span>02</span><h3>Claude Code</h3><p>Ask your administrator for an API key, then run:</p><pre>{`claude mcp add --transport http ${org.slug} \
  ${origin}/mcp/${org.slug} \
  --header "X-API-Key: <your key>"`}</pre></div>
                    </div>
                  </details>
                </>
              )}
            </section>
          ))}
        </div>

        <footer className="home-footer">
          <span>Signed in as {viewer.email ?? "your account"}</span>
          <Link href="/set-password">Change password</Link>
        </footer>
      </main>
    </div>
  );
}
