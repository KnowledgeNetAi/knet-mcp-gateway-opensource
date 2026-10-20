import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

interface UsageRow {
  ts: string;
  user_id: string | null;
  app: string | null;
  tool: string | null;
  decision: string;
  result_count: number | null;
  duration_ms: number | null;
}

export interface UsageItem { name: string; calls: number; share: number }
export interface UsageStats {
  days: number;
  totalCalls: number;
  allowedCalls: number;
  deniedCalls: number;
  errorCalls: number;
  averageDurationMs: number | null;
  /** Typical call: half of recorded calls took this long or less. */
  medianDurationMs: number | null;
  /** 90% of recorded calls took this long or less; the rest are the slow tail. */
  p90DurationMs: number | null;
  totalResults: number;
  tools: UsageItem[];
  users: UsageItem[];
  apps: UsageItem[];
  truncated: boolean;
}

const MAX_ROWS = 10_000;

/** Rows asked for per request. PostgREST's max-rows caps a response at 1,000. */
const PAGE_SIZE = 1000;

type PageFetcher<T> = (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/**
 * Reads up to `max` rows through `fetchPage(from, to)` (inclusive range).
 *
 * A single `.limit(10_000)` does not work: PostgREST silently caps every
 * response at the project's max-rows (1,000), which pinned the Usage page at
 * exactly "1,000 calls" for any busy org while the real 30-day count was
 * nearly 3,000. This pages with `.range()` and advances by the rows actually
 * returned, so it stays correct if the server cap is smaller than PAGE_SIZE.
 * One extra row past `max` is requested so `truncated` is exact.
 */
export async function fetchPaged<T>(fetchPage: PageFetcher<T>, max: number): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  while (rows.length <= max) {
    const from = rows.length;
    const to = Math.min(from + PAGE_SIZE, max + 1) - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
  }
  return { rows: rows.slice(0, max), truncated: rows.length > max };
}

/** Nearest-rank percentile of an ascending array; null when empty. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function ranked(values: Map<string, number>, total: number): UsageItem[] {
  return [...values.entries()]
    .map(([name, calls]) => ({ name, calls, share: total === 0 ? 0 : Math.round((calls / total) * 100) }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

export function aggregateUsage(rows: UsageRow[], emails: Map<string, string>, days = 30, truncated = false): UsageStats {
  const tools = new Map<string, number>();
  const users = new Map<string, number>();
  const apps = new Map<string, number>();
  let allowedCalls = 0;
  let deniedCalls = 0;
  let errorCalls = 0;
  const durations: number[] = [];
  let totalResults = 0;

  for (const row of rows) {
    if (row.decision === "allowed") allowedCalls += 1;
    else if (row.decision === "error") errorCalls += 1;
    else deniedCalls += 1;
    if (row.tool) tools.set(row.tool, (tools.get(row.tool) ?? 0) + 1);
    if (row.app) apps.set(row.app, (apps.get(row.app) ?? 0) + 1);
    if (row.user_id) {
      const name = emails.get(row.user_id) ?? row.user_id;
      users.set(name, (users.get(name) ?? 0) + 1);
    }
    if (row.duration_ms !== null) durations.push(row.duration_ms);
    totalResults += row.result_count ?? 0;
  }

  durations.sort((a, b) => a - b);

  return {
    days,
    totalCalls: rows.length,
    allowedCalls,
    deniedCalls,
    errorCalls,
    averageDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    medianDurationMs: percentile(durations, 0.5),
    p90DurationMs: percentile(durations, 0.9),
    totalResults,
    tools: ranked(tools, rows.length),
    users: ranked(users, rows.length),
    apps: ranked(apps, rows.length),
    truncated,
  };
}

export async function orgUsageStats(orgId: string, days = 30): Promise<UsageStats> {
  const supabase = createAdminClient();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  // Ordered by (ts, id) so consecutive pages never skip or repeat a row that
  // shares a timestamp with its neighbor.
  let rows: UsageRow[];
  let truncated: boolean;
  try {
    ({ rows, truncated } = await fetchPaged<UsageRow>(
      (from, to) =>
        supabase
          .from("audit_events")
          .select("ts, user_id, app, tool, decision, result_count, duration_ms")
          .eq("org_id", orgId)
          .gte("ts", since)
          .order("ts", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to),
      MAX_ROWS,
    ));
  } catch (error) {
    throw new Error(`error loading usage for org "${orgId}": ${(error as Error).message}`);
  }

  const { data: page, error: usersError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (usersError) throw new Error(`error resolving usage users: ${usersError.message}`);
  const emails = new Map((page?.users ?? []).map((user) => [user.id, user.email ?? user.id]));
  return aggregateUsage(rows, emails, days, truncated);
}
