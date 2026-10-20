import { describe, it, expect, vi } from "vitest";
import { createHttp } from "@/lib/http/client";
import { UpstreamError } from "@/lib/http/errors";
import type { TransportDef } from "@/lib/types";

// Service Fusion reports its quota on every response (observed 2026-10-12 against one
// customer account: `x-rate-limit-limit: 120`, `x-rate-limit-remaining` counting down, and
// `x-rate-limit-reset` counting down the seconds left in a fixed 60s window) and sends no
// Retry-After. Without reading those headers, a 429 falls through to the 250ms..8s backoff
// ladder, which gives up long before a window that can have up to 60s left.

const base: TransportDef = {
  minIntervalMs: 0,
  timeoutMs: 5000,
  retry: { attempts: 3, on: ["429", "5xx"], respectRetryAfter: true },
  errors: { format: "json" },
  rateLimit: { remainingHeader: "x-rate-limit-remaining", resetHeader: "x-rate-limit-reset" },
};

const res = (status: number, quota?: { remaining: string; reset: string }) =>
  new Response(status === 200 ? "{}" : "slow down", {
    status,
    headers: quota ? { "x-rate-limit-remaining": quota.remaining, "x-rate-limit-reset": quota.reset } : {},
  });

describe("createHttp — upstream quota headers", () => {
  it("holds the next call until the reset once remaining reaches 0", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(200, { remaining: "0", reset: "1" })).mockResolvedValueOnce(res(200));
    const http = createHttp(base, f as unknown as typeof fetch);

    await http.request("https://x.test/a", {});
    const started = Date.now();
    await http.request("https://x.test/b", {});
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not hold while quota remains", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(200, { remaining: "5", reset: "1" })).mockResolvedValueOnce(res(200));
    const http = createHttp(base, f as unknown as typeof fetch);

    await http.request("https://x.test/a", {});
    const started = Date.now();
    await http.request("https://x.test/b", {});
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("a 429 without Retry-After waits out the reset, then retries once", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(429, { remaining: "0", reset: "1" })).mockResolvedValueOnce(res(200));
    const http = createHttp(base, f as unknown as typeof fetch);

    const started = Date.now();
    const out = await http.request("https://x.test/a", {});
    expect(out.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("fails fast, without sending, when the reset lies past the call's deadline", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(200, { remaining: "0", reset: "30" }));
    const http = createHttp({ ...base, timeoutMs: 1000 }, f as unknown as typeof fetch);

    await http.request("https://x.test/a", {});
    const started = Date.now();
    await expect(http.request("https://x.test/b", {})).rejects.toThrow(UpstreamError);
    expect(Date.now() - started).toBeLessThan(200);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("ignores a reset beyond 60s rather than freezing the app on a garbled header", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(200, { remaining: "0", reset: "999999" })).mockResolvedValueOnce(res(200));
    const http = createHttp(base, f as unknown as typeof fetch);

    await http.request("https://x.test/a", {});
    const started = Date.now();
    await http.request("https://x.test/b", {});
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("ignores the headers entirely when the transport declares no rateLimit", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(200, { remaining: "0", reset: "1" })).mockResolvedValueOnce(res(200));
    const { rateLimit: _omit, ...plain } = base;
    const http = createHttp(plain, f as unknown as typeof fetch);

    await http.request("https://x.test/a", {});
    const started = Date.now();
    await http.request("https://x.test/b", {});
    expect(Date.now() - started).toBeLessThan(200);
  });
});
