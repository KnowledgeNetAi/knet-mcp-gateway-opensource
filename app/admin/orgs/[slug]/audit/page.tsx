import Link from "next/link";
import { requireOrgAdmin } from "@/lib/authz/viewer";
import { createAdminClient } from "@/lib/supabase/admin";
import { AdminFrame } from "@/components/admin/frame";
import { AdminTable } from "@/components/admin/table";
import { OrgNav } from "@/components/admin/org-nav";

type Params = Promise<{ slug: string }>;
type SearchParams = Promise<{ before?: string }>;

/** Matches the page size the per-org index (`audit_events_org_ts_idx`) is sized around. */
const PAGE_SIZE = 100;

interface AuditRow {
  id: number;
  ts: string;
  principal_kind: string;
  app: string | null;
  tool: string | null;
  decision: string;
  result_count: number | null;
  duration_ms: number | null;
  error: string | null;
}

function formatDay(ts: string): string {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatClock(ts: string): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
}

function formatDuration(ms: number | null): string {
  return ms === null ? "—" : `${ms.toLocaleString()} ms`;
}

/** Badge tone per decision: green for allowed, amber for upstream errors, red for every denial. */
function decisionBadge(decision: string): string {
  if (decision === "allowed") return "admin-badge admin-badge-ok";
  if (decision === "error") return "admin-badge admin-badge-warn";
  return "admin-badge admin-badge-danger";
}

/**
 * `/admin/orgs/[slug]/audit`. `requireOrgAdmin` gates the page — same as
 * every other org admin route.
 *
 * This page is READ ONLY. Unlike every mutation elsewhere under `/admin`, it
 * does not call `writeAdminAudit`: `admin_audit_events` records admin
 * *actions*, and viewing a log is not one (Global Constraints; the plan's
 * self-review notes make this explicit).
 *
 * Paginated with `?before=<ISO ts>` rather than an offset — offset
 * pagination drifts as rows are inserted between page loads, silently
 * skipping or repeating rows as the table grows underneath it. The query
 * below (`eq(org_id).order(ts desc).lt(ts, before)`) is exactly what
 * `audit_events_org_ts_idx` on `(org_id, ts desc)` was built to cover, so no
 * new index is added here.
 */
export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { slug } = await params;
  const { org } = await requireOrgAdmin(slug);
  const { before: rawBefore } = await searchParams;
  // `before` is user-editable in the address bar. Supabase parameterizes it,
  // so there is no injection risk, but handing Postgres an unparseable
  // timestamp makes the query error and takes the whole page down with a 500.
  // An unusable cursor simply means "start from the top".
  const before =
    rawBefore && !Number.isNaN(Date.parse(rawBefore)) ? rawBefore : undefined;

  const admin = createAdminClient();
  const base = admin
    .from("audit_events")
    .select("id, ts, principal_kind, app, tool, decision, result_count, duration_ms, error")
    .eq("org_id", org.id)
    .order("ts", { ascending: false })
    .limit(PAGE_SIZE);

  const { data, error } = await (before ? base.lt("ts", before) : base);
  if (error) {
    throw new Error(`AuditPage: error listing audit events for org "${org.id}": ${error.message}`);
  }

  const rows = (data ?? []) as AuditRow[];
  const lastRow = rows[rows.length - 1];
  const hasMore = rows.length === PAGE_SIZE;

  return (
    <AdminFrame
      eyebrow={`Organizations / ${org.slug} / Audit log`}
      title="Audit log"
      lede={`${rows.length} event${rows.length === 1 ? "" : "s"}${before ? " (older)" : ""}`}
    >
      <OrgNav slug={slug} />
      {rows.length === 0 ? (
        <p className="admin-empty">No audit events recorded yet.</p>
      ) : (
        <AdminTable
          title={before ? "Older events" : "Most recent events"}
          count={rows.length}
          columns={[
            "Time",
            "Principal",
            "App",
            "Tool",
            "Decision",
            { label: "Results", align: "end" },
            { label: "Duration", align: "end" },
            "Error",
          ]}
        >
          {rows.map((row) => (
            <tr key={row.id} data-decision={row.decision}>
              <td className="admin-date-stack">
                <span>{formatClock(row.ts)}</span>
                <small>{formatDay(row.ts)}</small>
              </td>
              <td className="admin-muted">{row.principal_kind}</td>
              <td>{row.app ?? <span className="admin-muted">—</span>}</td>
              <td>{row.tool ? <span className="admin-chip">{row.tool}</span> : <span className="admin-muted">—</span>}</td>
              <td className={row.decision === "denied_org_mismatch" ? "admin-decision-critical" : undefined}>
                <span className={decisionBadge(row.decision)}>{row.decision.replaceAll("_", " ")}</span>
              </td>
              <td className="admin-num">{row.result_count?.toLocaleString() ?? "—"}</td>
              <td className="admin-num">{formatDuration(row.duration_ms)}</td>
              <td>
                {row.error ? (
                  <span className="admin-truncate" title={row.error}>{row.error}</span>
                ) : (
                  <span className="admin-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </AdminTable>
      )}

      {hasMore && lastRow && (
        <div className="admin-links">
          <Link
            className="admin-link"
            href={`/admin/orgs/${org.slug}/audit?before=${encodeURIComponent(lastRow.ts)}`}
          >
            Older events →
          </Link>
        </div>
      )}
    </AdminFrame>
  );
}
