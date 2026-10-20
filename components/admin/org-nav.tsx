import Link from "next/link";

/** Shared organization navigation. Catalog and usage are admin-only surfaces. */
export function OrgNav({ slug, canAdmin = true }: { slug: string; canAdmin?: boolean }) {
  return (
    <nav className="admin-subnav" aria-label="Organization">
      <Link href={`/admin/orgs/${slug}`} className="admin-link">Overview</Link>
      {canAdmin && <Link href={`/admin/orgs/${slug}/members`} className="admin-link">Members</Link>}
      {canAdmin && <Link href={`/admin/orgs/${slug}/analytics`} className="admin-link">Usage</Link>}
      {canAdmin && <Link href={`/admin/orgs/${slug}/credentials`} className="admin-link">Credentials</Link>}
      {canAdmin && <Link href={`/admin/orgs/${slug}/keys`} className="admin-link">API keys</Link>}
      {canAdmin && <Link href={`/admin/orgs/${slug}/audit`} className="admin-link">Audit log</Link>}
    </nav>
  );
}
