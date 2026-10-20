import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getViewer } from "@/lib/authz/viewer";

/**
 * Shell for every `/admin/**` page: resolves the viewer once, bounces a
 * signed-out visitor to `/login`, and renders the nav. "All organizations"
 * and "Platform admins" are cross-org, super-admin-only surfaces — they only
 * appear in the nav for a super admin, mirroring §3 of the design spec.
 *
 * This is a page-view gate, not an authorization boundary for a mutation:
 * every Server Action under `/admin` still resolves its own viewer and
 * performs its own check (Global Constraints) rather than relying on having
 * rendered inside this layout.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");

  return (
    <div className="admin-shell">
      <nav className="admin-nav">
        <Link href="/admin" className="admin-nav-wordmark"><span className="admin-logo-mark">G</span><span>MCP Gateway</span><small>Admin</small></Link>
        {viewer.isSuperAdmin && (
          <div className="admin-nav-links">
            <Link href="/admin" className="admin-nav-link">
              All organizations
            </Link>
            <Link href="/admin/platform/admins" className="admin-nav-link">
              Platform admins
            </Link>
          </div>
        )}
      </nav>
      <main className="admin-main">{children}</main>
    </div>
  );
}
