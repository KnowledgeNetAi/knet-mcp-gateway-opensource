import { describe, it, expect, vi, afterEach } from "vitest";
import { createHttp } from "@/lib/http/client";
import { UpstreamError } from "@/lib/http/errors";
import type { TransportDef } from "@/lib/types";

// Task 11 fix round 4, finding I. Fix round 3 folded the throttle *wait* into the request
// deadline, but every `sleep(...)` between retries — backoff and Retry-After alike — was still
// bare, so the ladder only ever stopped because the *next* `throttle()` call refused, after
// already sleeping past the deadline. Under the real config Task 12 ships
// (`timeoutMs: 120000`, `attempts: 5`, `respectRetryAfter: true`, a 60s `MAX_RETRY_AFTER_MS`
// cap), a single call could run up to 180s while claiming a 120s deadline.

const base: TransportDef = {
  minIntervalMs: 0,
  timeoutMs: 5000,
  retry: { attempts: 5, on: ["429", "5xx", "truncated"], respectRetryAfter: false },
  errors: { format: "json" },
};

const res = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => {
  vi.useRealTimers();
});

describe("retry backoff and Retry-After sleeps are also clamped to the request deadline", () => {
  it("a retry ladder that would exceed the deadline stops AT the deadline, not after sleeping past it", async () => {
    // Deliberately does not stop at asserting the call eventually rejects, or even at counting
    // fetches: with only the throttle-level deadline check from fix round 3 (no clamp on the
    // backoff sleep itself), attempt 3 here is *also* never reached -- the next `throttle()`
    // call still refuses before firing it, so a call-count assertion alone cannot tell "stopped
    // promptly at the 600ms deadline" apart from "slept the full 500+1000ms of backoff first,
    // arrived at 1500ms, and only THEN got refused by the next throttle() call" — which is
    // exactly the gap finding I describes ("the ladder terminates only because the next
    // throttle() refuses — after sleeping past the deadline"). Tracking *when* it settles is
    // what actually distinguishes the two.
    vi.useFakeTimers();
    const f = vi.fn(async () => res(502, "boom"));
    const start = Date.now();
    let settledAt: number | null = null;
    // backoff(1)=500ms, backoff(2)=1000ms. attempt 1 fires at t0; the 500ms backoff before
    // attempt 2 fits inside the 600ms deadline (ends at t500); the 1000ms backoff before
    // attempt 3 would end at t1500, past the 600ms deadline, and must fail fast instead of
    // being slept through.
    const t: TransportDef = { ...base, timeoutMs: 600, retry: { attempts: 5, on: ["5xx"], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);

    const p = http.request("https://x.test/a", {});
    p.catch(() => { settledAt = Date.now() - start; });
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(p).rejects.toBeInstanceOf(UpstreamError);
    // Not all 5 attempts: the deadline stops the ladder after the second fetch, well short of
    // exhausting `attempts`.
    expect(f).toHaveBeenCalledTimes(2);
    // The real assertion: settles at (or just past) the 600ms deadline, not at ~1500ms —
    // i.e. failed *at* the deadline, never having slept past it in the first place.
    expect(settledAt).not.toBeNull();
    expect(settledAt as unknown as number).toBeLessThan(700);
  });

  it("a Retry-After beyond the remaining budget fails fast instead of sleeping through it", async () => {
    vi.useFakeTimers();
    const f = vi.fn()
      .mockResolvedValueOnce(res(429, "slow down", { "retry-after": "30" }))
      .mockResolvedValueOnce(res(200, "{}"));
    const t: TransportDef = {
      ...base, timeoutMs: 500,
      retry: { attempts: 2, on: ["429"], respectRetryAfter: true },
    };
    const http = createHttp(t, f as unknown as typeof fetch);

    const p = http.request("https://x.test/a", {});
    p.catch(() => {});
    // Only a small advance -- nowhere near the 30s Retry-After, and past the 500ms deadline.
    // A correct implementation never sleeps the 30s at all, so it has already failed by here;
    // the pre-fix implementation would still be waiting out the 30s Retry-After sleep.
    await vi.advanceTimersByTimeAsync(100);

    await expect(p).rejects.toBeInstanceOf(UpstreamError);
    // Must NOT have shortened the wait and retried early either (that would be the exact
    // stampede MAX_RETRY_AFTER_MS exists to prevent) -- the second (successful) response is
    // never reached.
    expect(f).toHaveBeenCalledTimes(1);
  });
});
