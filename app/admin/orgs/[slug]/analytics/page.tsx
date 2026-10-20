import { requireOrgAdmin } from "@/lib/authz/viewer";
import { orgUsageStats, type UsageItem } from "@/lib/admin/stats";
import { AdminFrame, AdminNotice } from "@/components/admin/frame";
import { AdminTable } from "@/components/admin/table";
import { OrgNav } from "@/components/admin/org-nav";

type Params = Promise<{ slug: string }>;

/**
 * Median rather than mean: calls that queue behind a burst on a shared
 * upstream credential take 30 s or more and dragged the old "average latency"
 * to 8 s when the typical call took about 2 s.
 */
function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** `mono` renders names as code chips — right for tool and app identifiers, wrong for emails. */
function Ranking({ title, column, items, mono = false }: { title: string; column: string; items: UsageItem[]; mono?: boolean }) {
  return (
    <section className="admin-panel admin-ranking">
      <div className="admin-section-heading"><h2 className="admin-section-title">{title}</h2></div>
      {items.length === 0 ? <p className="admin-empty">No usage recorded.</p> : (
        <AdminTable columns={[column, { label: "Calls", align: "end" }, "Share"]}>
          {items.slice(0, 10).map((item) => (
            <tr key={item.name}>
              <td>{mono ? <span className="admin-chip">{item.name}</span> : item.name}</td>
              <td className="admin-num">{item.calls.toLocaleString()}</td>
              <td className="admin-share-cell"><span>{item.share === 0 && item.calls > 0 ? "<1" : item.share}%</span><i style={{ width: `${item.share}%` }} /></td>
            </tr>
          ))}
        </AdminTable>
      )}
    </section>
  );
}

export default async function AnalyticsPage({ params }: { params: Params }) {
  const { slug } = await params;
  const { org } = await requireOrgAdmin(slug);
  const stats = await orgUsageStats(org.id, 30);

  return (
    <AdminFrame eyebrow={`Organizations / ${org.slug} / Usage`} title="Usage" lede="The last 30 days of gateway activity.">
      <OrgNav slug={slug} />
      {stats.truncated && <AdminNotice label="Large result set">Showing the 10,000 most recent calls in this period.</AdminNotice>}
      <div className="admin-stat-grid">
        <article className="admin-stat-card"><span>Total calls</span><strong>{stats.totalCalls.toLocaleString()}</strong><small>{stats.allowedCalls.toLocaleString()} allowed</small></article>
        <article className="admin-stat-card"><span>Denied</span><strong>{stats.deniedCalls.toLocaleString()}</strong><small>{stats.errorCalls.toLocaleString()} upstream errors</small></article>
        <article className="admin-stat-card"><span>Results returned</span><strong>{stats.totalResults.toLocaleString()}</strong><small>Across allowed calls</small></article>
        <article className="admin-stat-card"><span>Typical latency</span><strong>{formatDuration(stats.medianDurationMs)}</strong><small>{stats.p90DurationMs === null ? "No timed calls" : `Slowest 10% over ${formatDuration(stats.p90DurationMs)}`}</small></article>
      </div>
      <div className="admin-ranking-grid">
        <Ranking title="Top tools" column="Tool" items={stats.tools} mono />
        <Ranking title="Top users" column="User" items={stats.users} />
      </div>
      <Ranking title="Top apps" column="App" items={stats.apps} mono />
    </AdminFrame>
  );
}
