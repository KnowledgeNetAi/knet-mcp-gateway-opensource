import { redirect } from "next/navigation";
import Link from "next/link";
import { getViewer } from "@/lib/authz/viewer";
import { listAllOrgs } from "@/lib/admin/orgs";
import { AdminFrame, AdminNotice } from "@/components/admin/frame";
import { AdminTable } from "@/components/admin/table";

type SearchParams = Promise<{ error?: string }>;

const ERRORS: Record<string, { label: string; detail: string }> = {
  forbidden: {
    label: "Not permitted",
    detail: "You don't have access to that organization.",
  },
};

/**
 * `/admin`. A super admin sees every organization; anyone else lands on
 * their own org directly (exactly one) or a picker (several) — mirroring
 * §3 of the design spec. `getViewer` is re-resolved here (not merely
 * inherited from `app/admin/layout.tsx`) since this page also needs to know
 * `isSuperAdmin` and the viewer's own org list, not just whether someone is
 * signed in.
 */
export default async function AdminPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const error = sp.error ? ERRORS[sp.error] : null;

  const viewer = await getViewer();
  if (!viewer) redirect("/login");

  if (!viewer.isSuperAdmin) {
    if (viewer.orgs.length === 1) {
      redirect(`/admin/orgs/${viewer.orgs[0].slug}`);
    }

    return (
      <AdminFrame eyebrow="Organizations" title="Your organizations">
        {error && (
          <AdminNotice tone="error" label={error.label}>
            {error.detail}
          </AdminNotice>
        )}
        {viewer.orgs.length === 0 ? (
          <AdminNotice label="Nothing here yet">
            You are not a member of any organization on this gateway.
          </AdminNotice>
        ) : (
          <ul className="admin-picker">
            {viewer.orgs.map((org) => (
              <li key={org.id}>
                <Link href={`/admin/orgs/${org.slug}`} className="admin-picker-link">
                  {org.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </AdminFrame>
    );
  }

  const orgs = await listAllOrgs();

  return (
    <AdminFrame eyebrow="Organizations" title="All organizations">
      {error && (
        <AdminNotice tone="error" label={error.label}>
          {error.detail}
        </AdminNotice>
      )}
      <div className="admin-links">
        <Link href="/admin/orgs/new" className="admin-btn admin-btn-primary">
          New organization
        </Link>
      </div>
      <AdminTable
        title="Organizations"
        count={orgs.length}
        columns={[
          "Organization",
          "Slug",
          { label: "Apps", align: "end" },
          { label: "Members", align: "end" },
          { label: "Active keys", align: "end" },
        ]}
      >
        {orgs.map((org) => (
          <tr key={org.id}>
            <td>
              <Link href={`/admin/orgs/${org.slug}`}>{org.name}</Link>
            </td>
            <td><span className="admin-chip">{org.slug}</span></td>
            <td className="admin-num">{org.appCount}</td>
            <td className="admin-num">{org.memberCount}</td>
            <td className="admin-num">{org.activeKeyCount}</td>
          </tr>
        ))}
      </AdminTable>
    </AdminFrame>
  );
}
