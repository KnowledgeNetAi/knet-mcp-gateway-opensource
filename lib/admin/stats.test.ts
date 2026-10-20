import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { aggregateUsage, fetchPaged } from "@/lib/admin/stats";

describe("aggregateUsage", () => {
  it("ranks tools and resolves users while separating denied calls from errors", () => {
    const rows = [
      { ts: "2026-01-01", user_id: "u1", app: "fieldedge", tool: "customer_search", decision: "allowed", result_count: 4, duration_ms: 100 },
      { ts: "2026-01-01", user_id: "u1", app: "fieldedge", tool: "customer_search", decision: "allowed", result_count: 2, duration_ms: 200 },
      { ts: "2026-01-01", user_id: "u2", app: "fieldedge", tool: "invoice_get", decision: "denied_no_grant", result_count: null, duration_ms: null },
      { ts: "2026-01-01", user_id: "u2", app: "fieldedge", tool: "invoice_get", decision: "error", result_count: null, duration_ms: 300 },
    ];
    const stats = aggregateUsage(rows, new Map([["u1", "owner@example.com"]]));

    expect(stats).toMatchObject({ totalCalls: 4, allowedCalls: 2, deniedCalls: 1, errorCalls: 1, averageDurationMs: 200, totalResults: 6 });
    expect(stats.tools[0]).toEqual({ name: "customer_search", calls: 2, share: 50 });
    expect(stats.users[0]).toEqual({ name: "owner@example.com", calls: 2, share: 50 });
  });
});

describe("latency percentiles", () => {
  const row = (duration_ms: number | null) => ({ ts: "2026-01-01", user_id: null, app: "a", tool: "t", decision: "allowed", result_count: 0, duration_ms });

  it("reports the median and slowest-10% threshold, which a long tail cannot drag", () => {
    // Eight quick calls and two that queued for 90 s: the mean says ~19 s,
    // the typical call took 1 s.
    const rows = [...Array.from({ length: 8 }, () => row(1000)), row(90_000), row(90_000)];
    const stats = aggregateUsage(rows, new Map());
    expect(stats.averageDurationMs).toBe(18_800);
    expect(stats.medianDurationMs).toBe(1000);
    expect(stats.p90DurationMs).toBe(90_000);
  });

  it("uses nearest-rank, ignores calls with no recorded duration, and is null when none have one", () => {
    const stats = aggregateUsage([row(300), row(100), row(null), row(200)], new Map());
    expect(stats.medianDurationMs).toBe(200);
    expect(stats.p90DurationMs).toBe(300);
    expect(aggregateUsage([row(null)], new Map())).toMatchObject({ medianDurationMs: null, p90DurationMs: null });
  });
});

describe("fetchPaged", () => {
  // PostgREST caps every response at the project's max-rows (1,000 here)
  // regardless of the `.limit()` asked for — that cap silently pinned the
  // Usage page at "1,000 calls" for any busy org.
  const SERVER_CAP = 1000;
  const table = Array.from({ length: 2713 }, (_, i) => i);
  const page = async (from: number, to: number) => ({
    data: table.slice(from, Math.min(to + 1, from + SERVER_CAP)),
    error: null,
  });

  it("reads past the server's per-request row cap", async () => {
    const { rows, truncated } = await fetchPaged(page, 10_000);
    expect(rows).toHaveLength(2713);
    expect(rows.at(-1)).toBe(2712);
    expect(truncated).toBe(false);
  });

  it("stops at the ceiling and reports truncation", async () => {
    const { rows, truncated } = await fetchPaged(page, 2000);
    expect(rows).toHaveLength(2000);
    expect(truncated).toBe(true);
  });

  it("is not truncated when the data ends exactly on the ceiling", async () => {
    const { rows, truncated } = await fetchPaged(async (from, to) => ({ data: table.slice(0, 2000).slice(from, to + 1), error: null }), 2000);
    expect(rows).toHaveLength(2000);
    expect(truncated).toBe(false);
  });

  it("surfaces a query error", async () => {
    await expect(fetchPaged(async () => ({ data: null, error: { message: "boom" } }), 10)).rejects.toThrow("boom");
  });
});
