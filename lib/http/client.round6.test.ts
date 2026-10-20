import { describe, it, expect, vi, afterEach } from "vitest";
import { createHttp } from "@/lib/http/client";
import { UpstreamError } from "@/lib/http/errors";
import type { TransportDef } from "@/lib/types";

// Task 11 fix round 3, finding F. Restoring `buildContext`'s per-app `Http` memoization (round
// 2, finding A) made the throttle real again in production — which also made its two
// pre-existing gaps live: `timeoutMs` measured only the fetch, never the queue wait ahead of
// it, and nothing bounded how long a caller could be made to wait in that queue at all. A
// tenant shaped like this one (one account-wide credential, an LLM client that fans out parallel tool calls)
// means an unbounded queue against a real `minIntervalMs` (600ms in Task 12's actual Service
// Fusion config) is the whole risk this file's throttle exists to bound.

const base: TransportDef = {
  minIntervalMs: 0,
  timeoutMs: 5000,
  retry: { attempts: 1, on: [], respectRetryAfter: false },
  errors: { format: "json" },
};

const res = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.useRealTimers();
});

describe("the throttle wait is folded into the request deadline", () => {
  it("ordinary spacing under the limit is unchanged: re-measures the six-call ladder at 0,300,600,900,1200,1500 when the deadline permits", async () => {
    vi.useFakeTimers();
    const callOffsets: number[] = [];
    const start = Date.now();
    const f = vi.fn(async () => {
      callOffsets.push(Date.now() - start);
      return res(200, "{}");
    });
    // Generous timeoutMs (5000ms) comfortably covers the whole 1500ms queue — nothing here
    // should fail fast.
    const t: TransportDef = { ...base, minIntervalMs: 300, timeoutMs: 5000 };
    const http = createHttp(t, f as unknown as typeof fetch);

    const requests = Array.from({ length: 6 }, () => http.request("https://x.test/a", {}));
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all(requests);

    expect(callOffsets).toEqual([0, 300, 600, 900, 1200, 1500]);
  });

  it("fails fast, without waiting, when the queue wait alone would exceed timeoutMs", async () => {
    vi.useFakeTimers();
    const callOffsets: number[] = [];
    const start = Date.now();
    const f = vi.fn(async () => {
      callOffsets.push(Date.now() - start);
      return res(200, "{}");
    });
    // Six concurrent calls at minIntervalMs:300 reserve slots 0, 300, 600, 900, 1200, 1500.
    // A 1000ms deadline covers the first four but not the last two.
    const t: TransportDef = { ...base, minIntervalMs: 300, timeoutMs: 1000 };
    const http = createHttp(t, f as unknown as typeof fetch);

    const requests = Array.from({ length: 6 }, () => http.request("https://x.test/a", {}));

    // The two over-budget calls (reserved at 1200ms and 1500ms) must reject *before* any
    // fake-timer advance — proving they never joined the queue at all, rather than merely
    // rejecting once an unbounded wait eventually elapsed.
    await expect(requests[4]).rejects.toBeInstanceOf(UpstreamError);
    await expect(requests[5]).rejects.toBeInstanceOf(UpstreamError);

    await vi.advanceTimersByTimeAsync(900);
    await Promise.all(requests.slice(0, 4));

    expect(callOffsets).toEqual([0, 300, 600, 900]);
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("fails fast with a normal UpstreamError (status 0, no URL/body leaked) so the handler reports gateway_error", async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => res(200, "{}"));
    const t: TransportDef = { ...base, minIntervalMs: 2000, timeoutMs: 100 };
    const http = createHttp(t, f as unknown as typeof fetch);

    await http.request("https://x.test/a", {}); // consumes the first (unthrottled) slot
    const overBudget = http.request("https://x.test/a", {});
    await expect(overBudget).rejects.toBeInstanceOf(UpstreamError);
    await expect(overBudget).rejects.toMatchObject({ status: 0 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  // Task 11 fix round 4, finding J: the two tests above dispatch a single batch where every
  // refusal sits *after* every accepted call (slots 1200ms/1500ms refused, 0/300/600/900ms
  // accepted) — so a mutation that committed `lastAt = at` in the fail-fast branch before
  // throwing is invisible to them; there is no accepted call later in the same batch whose
  // schedule such a mutation could visibly corrupt. This test issues a fourth call *after* a
  // refusal, specifically to observe whether the refusal wrongly reserved a slot for it.
  it("a fail-fast refusal does not reserve a throttle slot for a later caller", async () => {
    vi.useFakeTimers();
    const callOffsets: number[] = [];
    const start = Date.now();
    const f = vi.fn(async () => {
      callOffsets.push(Date.now() - start);
      return res(200, "{}");
    });
    const t: TransportDef = { ...base, minIntervalMs: 1000, timeoutMs: 1500 };
    const http = createHttp(t, f as unknown as typeof fetch);

    // Three concurrent calls reserve slots 0, 1000, 2000. The third (2000) exceeds this
    // instance's 1500ms deadline and must fail fast — and must not claim the 2000ms slot for
    // anyone else.
    const call1 = http.request("https://x.test/a", {});
    const call2 = http.request("https://x.test/a", {});
    const call3 = http.request("https://x.test/a", {});
    await expect(call3).rejects.toBeInstanceOf(UpstreamError);

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([call1, call2]);
    expect(callOffsets).toEqual([0, 1000]);

    // A fourth call, issued right after (fake "now" is ~1000ms here), gets its own fresh
    // 1000+1500=2500ms deadline. If the refused third call above had wrongly committed
    // `lastAt = 2000`, this call would compute its own slot as max(1000, 2000+1000) = 3000,
    // exceeding 2500, and be refused too. With the fix (nothing committed on refusal), `lastAt`
    // is still 1000 (from the second, accepted call), so this call's slot is
    // max(1000, 1000+1000) = 2000 <= 2500: accepted, firing at offset 2000.
    const call4 = http.request("https://x.test/a", {});
    await vi.advanceTimersByTimeAsync(1000);
    await call4;
    expect(callOffsets).toEqual([0, 1000, 2000]);
  });
});

describe("the fetch deadline shrinks by however long the queue wait already took", () => {
  // Task 11 fix round 4, finding J: the original version of this test asserted only that `f`
  // was called twice under `vi.useFakeTimers()` — which passes identically whether the fetch
  // signal's timeout is `remaining` (the fix) or a fresh, full `transport.timeoutMs` (the
  // mutation it was meant to guard against), because Node's `AbortSignal.timeout` is a real
  // timer untouched by vitest's fake-timer mocking: it simply never fires during a fake-timer
  // test, regardless of the duration it was given. Only a real clock — and an assertion that
  // actually depends on which duration the signal was given — can tell them apart.
  it("gives the fetch only the remaining budget, not a fresh full timeoutMs, after queueing", async () => {
    // Deliberately real timers. minIntervalMs:400, timeoutMs:1000: the first call is
    // unthrottled; the second is queued 400ms behind it, leaving it ~600ms of its own 1000ms
    // budget for the fetch itself. Its mock fetch takes 800ms to resolve — longer than the
    // ~600ms actually remaining, but shorter than a fresh full 1000ms — so it must time out
    // under the fix, and must NOT time out under the mutation.
    let callCount = 0;
    const f = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          callCount++;
          const delayMs = callCount === 1 ? 20 : 800;
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          const timer = setTimeout(() => resolve(res(200, "{}")), delayMs);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const t: TransportDef = { ...base, minIntervalMs: 400, timeoutMs: 1000 };
    const http = createHttp(t, f as unknown as typeof fetch);

    const first = http.request("https://x.test/a", {});
    const second = http.request("https://x.test/a", {}); // queued 400ms behind the first

    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(second).rejects.toBeInstanceOf(UpstreamError);
  });
});
