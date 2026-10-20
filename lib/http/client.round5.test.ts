import { describe, it, expect, vi, afterEach } from "vitest";
import { getEventListeners } from "node:events";
import { createHttp } from "@/lib/http/client";
import { UpstreamError } from "@/lib/http/errors";
import type { TransportDef } from "@/lib/types";

// Round-5 review fix. See
// .superpowers/sdd/2026-09-12-gateway-phase-1/task-8-report.md ("Round 5")
// for the full writeup.

const base: TransportDef = {
  minIntervalMs: 0,
  timeoutMs: 5000,
  retry: { attempts: 3, on: ["429", "5xx", "truncated"], respectRetryAfter: false },
  errors: { format: "html" },
};

const res = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Finding G (Minor) — sleep()'s abort listener (added in round 4 to make
// retry-backoff sleeps abortable) is registered with `{ once: true }`, which
// only self-removes once the "abort" event actually fires. On the far more
// common path — the timer wins the race, the signal never aborts — nothing
// ever removes it. Reusing one AbortController (e.g. a connection-scoped
// signal spanning many tool calls, the shape Task 11 is expected to wire up)
// accumulates one stale listener per retry-backoff sleep for the life of the
// signal.
// ---------------------------------------------------------------------------
describe("sleep does not leak abort listeners on the resolve path", () => {
  it("the caller's signal has zero abort listeners left after each of several sequential requests settles", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const f = vi.fn(async () => res(503, "down"));
    // attempts: 5 on an always-503 response means 4 retry-backoff sleeps per
    // request (the 5th attempt throws instead of sleeping) — matching the
    // reviewer's measured "4 listeners per request" exactly.
    const t: TransportDef = { ...base, retry: { attempts: 5, on: ["5xx"], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);

    for (let i = 0; i < 3; i++) {
      const p = http.request("https://x.test/a", { signal: controller.signal });
      p.catch(() => {});
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(p).rejects.toBeInstanceOf(UpstreamError);
      // After each request settles via the timer-wins (normal) path, no
      // abort listener should remain on the shared, reused signal.
      expect(getEventListeners(controller.signal, "abort").length).toBe(0);
    }
  });
});
