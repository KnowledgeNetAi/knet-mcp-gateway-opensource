import { describe, it, expect, vi } from "vitest";
import { createHttp } from "@/lib/http/client";
import { UpstreamError } from "@/lib/http/errors";
import type { TransportDef } from "@/lib/types";

// Round-4 review fixes. See
// .superpowers/sdd/2026-09-12-gateway-phase-1/task-8-report.md ("Round 4")
// for the full writeup.

const base: TransportDef = {
  minIntervalMs: 0,
  timeoutMs: 5000,
  retry: { attempts: 3, on: ["429", "5xx", "truncated"], respectRetryAfter: false },
  errors: { format: "html" },
};

const res = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(status === 204 || status === 205 ? null : body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

// ---------------------------------------------------------------------------
// Finding E (Important) — a caller abort landing during a retry backoff
// (rather than during the fetch itself) must not be held for the rest of the
// sleep, and must not let a further fetch fire against the upstream.
//
// Real timers are used deliberately here (per the finding) so elapsed time is
// genuine wall-clock evidence, not an artifact of fake-timer bookkeeping.
// ---------------------------------------------------------------------------
describe("caller abort during retry backoff", () => {
  it("does not fire another fetch after the caller aborts mid-backoff, and returns promptly", async () => {
    const controller = new AbortController();
    const f = vi.fn(async () => res(503, "down"));
    const t: TransportDef = { ...base, retry: { attempts: 3, on: ["5xx"], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);

    const start = Date.now();
    const p = http.request("https://x.test/a", { signal: controller.signal });
    p.catch(() => {});

    // Attempt 1 returns 503 almost immediately; the client then sleeps
    // backoff(1) = 500ms before attempt 2 would fire. Abort partway through
    // that sleep, well before the 500ms is up.
    setTimeout(() => controller.abort(), 100);

    let caught: unknown;
    try {
      await p;
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;

    // The call count is what matters: it's the shared, account-wide
    // credential being spent on a request nobody wants anymore.
    expect(f).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(400); // well under the full 500ms backoff
    expect(caught).not.toBeInstanceOf(UpstreamError);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Finding F (Minor) — pin down that a caller signal merely being *present*
// does not suppress retry; only the signal actually firing does. An
// overcorrection to `if (init.signal)` (instead of `if (init.signal?.aborted)`)
// would still pass the rest of the suite but silently break this.
// ---------------------------------------------------------------------------
describe("an unaborted caller signal does not suppress retry", () => {
  it("still retries a timeout when a caller signal is present but never fires", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController(); // deliberately never aborted
      const timeoutErr = new DOMException("timed out", "TimeoutError");
      const f = vi.fn()
        .mockRejectedValueOnce(timeoutErr)
        .mockResolvedValueOnce(res(200, '{"ok":true}'));
      const t: TransportDef = { ...base, retry: { attempts: 2, on: ["429", "5xx", "truncated"], respectRetryAfter: false } };
      const http = createHttp(t, f as unknown as typeof fetch);
      const p = http.request("https://x.test/a", { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(8000);
      const out = await p;
      expect(out.data).toEqual({ ok: true });
      expect(f).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
