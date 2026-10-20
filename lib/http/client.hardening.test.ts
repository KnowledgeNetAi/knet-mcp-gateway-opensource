import { describe, it, expect, vi, afterEach } from "vitest";
import { createHttp, summarize } from "@/lib/http/client";
import { UpstreamError } from "@/lib/http/errors";
import type { TransportDef } from "@/lib/types";

const base: TransportDef = {
  minIntervalMs: 0,
  timeoutMs: 5000,
  retry: { attempts: 3, on: ["429", "5xx", "truncated"], respectRetryAfter: false },
  errors: { format: "html" },
};

const res = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// (a) The retry loop's exit conditions.
// ---------------------------------------------------------------------------
describe("retry loop exit conditions", () => {
  it("attempts:1 makes no retry attempt on a retriable 429 and throws immediately", async () => {
    const f = vi.fn(async () => res(429, "slow down"));
    const t: TransportDef = { ...base, retry: { attempts: 1, on: ["429"], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);
    await expect(http.request("https://x.test/a", {})).rejects.toThrow(UpstreamError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("attempts:1 makes no retry attempt on a truncated body and throws immediately", async () => {
    const f = vi.fn(async () => res(200, '{"items":[1'));
    const t: TransportDef = { ...base, retry: { attempts: 1, on: ["truncated"], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);
    await expect(http.request("https://x.test/a", {})).rejects.toThrow(/truncated/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("an empty retry.on never retries a 429 or 5xx — throws on first attempt", async () => {
    const f = vi.fn(async () => res(503, "down"));
    const t: TransportDef = { ...base, retry: { attempts: 5, on: [], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);
    await expect(http.request("https://x.test/a", {})).rejects.toThrow(UpstreamError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("an unrecognized token in retry.on has no effect — a 409 is not retried", async () => {
    const f = vi.fn(async () => res(409, "conflict"));
    const t: TransportDef = { ...base, retry: { attempts: 5, on: ["409"], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);
    await expect(http.request("https://x.test/a", {})).rejects.toThrow(UpstreamError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retry.on tokens are matched case-insensitively (config typo like '5XX' still retries)", async () => {
    vi.useFakeTimers();
    const f = vi.fn()
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(res(200, "{}"));
    const t: TransportDef = { ...base, retry: { attempts: 2, on: ["5XX"], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);
    const p = http.request("https://x.test/a", {});
    await vi.advanceTimersByTimeAsync(8000);
    const out = await p;
    expect(out.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a 429 on the final attempt throws the right UpstreamError instead of falling out of the loop", async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => res(429, "still slow"));
    const t: TransportDef = { ...base, retry: { attempts: 2, on: ["429"], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);
    const p = http.request("https://x.test/a", {});
    p.catch(() => {}); // observed below; suppresses a spurious unhandledRejection while timers advance
    await vi.advanceTimersByTimeAsync(8000);
    let caught: unknown;
    try {
      await p;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).status).toBe(429);
    expect(f).toHaveBeenCalledTimes(2); // never a 3rd, phantom attempt
  });
});

// ---------------------------------------------------------------------------
// (b) Retry-After parsing.
//
// Round-2 correction: an uncapped/huge Retry-After does NOT hang a request —
// Node's setTimeout clamps any delay above 2^31-1 ms to 1ms, so the old
// "caps an enormous Retry-After instead of hanging" framing was wrong, and
// that test (plus four of the five below it) passed against the brief's
// original, un-hardened code regardless of whether a cap existed at all —
// they were vacuous. The real hazard is a *stampede*: honoring "wait 999999s"
// by sleeping ~1ms means retrying near-instantly against a single credential
// serving the whole org while claiming to have backed off. The fix is not a
// cap-then-retry-anyway; it's cap-then-refuse: honor Retry-After up to
// MAX_RETRY_AFTER_MS, and when the upstream asks for more than that, stop and
// throw rather than guess at an early retry.
// ---------------------------------------------------------------------------
describe("Retry-After parsing", () => {
  it("honors a plain delta-seconds Retry-After (the basic case nobody tested)", async () => {
    vi.useFakeTimers();
    const f = vi.fn()
      .mockResolvedValueOnce(res(503, "down", { "retry-after": "2" }))
      .mockResolvedValueOnce(res(200, "{}"));
    const t: TransportDef = { ...base, retry: { attempts: 2, on: ["5xx"], respectRetryAfter: true } };
    const http = createHttp(t, f as unknown as typeof fetch);
    const p = http.request("https://x.test/a", {});
    // A 2-second Retry-After should be honored, not raced past by backoff(1)=500ms.
    await vi.advanceTimersByTimeAsync(1900);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    const out = await p;
    expect(out.status).toBe(200);
  });

  it("throws instead of retrying when Retry-After exceeds the cap (no stampede)", async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => res(429, "slow down", { "retry-after": "300" }));
    const t: TransportDef = { ...base, retry: { attempts: 3, on: ["429"], respectRetryAfter: true } };
    const http = createHttp(t, f as unknown as typeof fetch);
    const p = http.request("https://x.test/a", {});
    p.catch(() => {});
    // Nothing to advance: this must reject synchronously-ish, without ever
    // sleeping or making a second call. A stampeding implementation would
    // instead sleep ~1ms (or the capped 60s) and call fetch again.
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).rejects.toThrow(/rate limited/i);
    await expect(p).rejects.toThrow(/300s/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("throws instead of retrying when Retry-After is garbage-huge, rather than stampeding at ~1ms", async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => res(503, "down", { "retry-after": "999999999999" }));
    const t: TransportDef = { ...base, retry: { attempts: 2, on: ["5xx"], respectRetryAfter: true } };
    const http = createHttp(t, f as unknown as typeof fetch);
    const p = http.request("https://x.test/a", {});
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).rejects.toThrow(/rate limited/i);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("treats a negative Retry-After as absent: the retry uses backoff timing, not an immediate stampede", async () => {
    vi.useFakeTimers();
    const f = vi.fn()
      .mockResolvedValueOnce(res(503, "down", { "retry-after": "-5" }))
      .mockResolvedValueOnce(res(200, "{}"));
    const t: TransportDef = { ...base, retry: { attempts: 2, on: ["5xx"], respectRetryAfter: true } };
    const http = createHttp(t, f as unknown as typeof fetch);
    const p = http.request("https://x.test/a", {});
    // backoff(1) === 500ms. A parser that dropped the positivity check would
    // treat "-5" as a value to honor and, since sleep() clamps a negative
    // delay to ~immediate, retry a full 500ms early — a stampede in
    // miniature. Asserting the call count *before* 500ms is what catches
    // that; asserting eventual success alone (the old version of this test)
    // does not.
    await vi.advanceTimersByTimeAsync(499);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const out = await p;
    expect(out.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("treats a zero Retry-After as absent: the retry uses backoff timing, not an immediate stampede", async () => {
    vi.useFakeTimers();
    const f = vi.fn()
      .mockResolvedValueOnce(res(503, "down", { "retry-after": "0" }))
      .mockResolvedValueOnce(res(200, "{}"));
    const t: TransportDef = { ...base, retry: { attempts: 2, on: ["5xx"], respectRetryAfter: true } };
    const http = createHttp(t, f as unknown as typeof fetch);
    const p = http.request("https://x.test/a", {});
    // "0" passes a digits-only regex, so this is the case a parser that
    // dropped the `seconds <= 0` positivity check would actually mishandle
    // (unlike "-5", which a digits-only regex rejects regardless): it would
    // treat 0 as a valid wait and retry near-instantly instead of at
    // backoff(1)=500ms.
    await vi.advanceTimersByTimeAsync(499);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const out = await p;
    expect(out.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("treats garbage Retry-After text as absent: the retry uses backoff timing, not an immediate stampede", async () => {
    vi.useFakeTimers();
    const f = vi.fn()
      .mockResolvedValueOnce(res(503, "down", { "retry-after": "banana" }))
      .mockResolvedValueOnce(res(200, "{}"));
    const t: TransportDef = { ...base, retry: { attempts: 2, on: ["5xx"], respectRetryAfter: true } };
    const http = createHttp(t, f as unknown as typeof fetch);
    const p = http.request("https://x.test/a", {});
    await vi.advanceTimersByTimeAsync(499);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const out = await p;
    expect(out.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("honors an HTTP-date Retry-After (not just delta-seconds) — genuinely gates against a Number()-only parser", async () => {
    vi.useFakeTimers();
    const target = new Date(Date.now() + 2000).toUTCString();
    const f = vi.fn()
      .mockResolvedValueOnce(res(503, "down", { "retry-after": target }))
      .mockResolvedValueOnce(res(200, "{}"));
    const t: TransportDef = { ...base, retry: { attempts: 2, on: ["5xx"], respectRetryAfter: true } };
    const http = createHttp(t, f as unknown as typeof fetch);
    const p = http.request("https://x.test/a", {});
    // Not enough time for the date-based wait to have elapsed yet. A parser
    // that only does Number(header) would get NaN here, fall back to
    // backoff(1)=500ms, and already have called fetch a second time.
    await vi.advanceTimersByTimeAsync(500);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    const out = await p;
    expect(out.status).toBe(200);
  });

  it("ignores Retry-After entirely when respectRetryAfter is false: retry uses backoff timing, not the header value", async () => {
    vi.useFakeTimers();
    const f = vi.fn()
      .mockResolvedValueOnce(res(503, "down", { "retry-after": "999999" }))
      .mockResolvedValueOnce(res(200, "{}"));
    const t: TransportDef = { ...base, retry: { attempts: 2, on: ["5xx"], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);
    const p = http.request("https://x.test/a", {});
    // backoff(1) === 500ms regardless of the huge header. Confirm the call
    // hasn't happened yet at 499ms (i.e. it isn't retrying near-instantly)
    // before confirming it has by 500ms (i.e. it isn't hanging either).
    await vi.advanceTimersByTimeAsync(499);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const out = await p;
    expect(out.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// (c) `summarize` against hostile input.
//
// Round-2 correction: the extraction regex `[^.]*\.` is NOT linear — it's
// quadratic in practice, because at every one of N candidate start
// positions (e.g. every repetition of "It seems") a failed match rescans
// forward to the end of the (capped) string looking for a ".". Measured
// against the *uncapped* regex: 5k chars → 3ms, 10k → 8ms, 20k → 33ms,
// 40k → 125ms (quadrupling as input doubles) — the length cap was the only
// thing keeping this bounded, and "just raise the cap" looked free in the
// original (wrong) writeup. The real fix bounds the match itself
// (`[^.]{0,300}\.`), which is linear regardless of cap size; the cap is
// kept only as defense in depth against pathological input *size* (memory,
// not backtracking).
// ---------------------------------------------------------------------------
describe("summarize against hostile input", () => {
  it("handles a multi-megabyte body quickly and returns a bounded string", () => {
    const filler = "<div>no sentence markers here at all</div>".repeat(150_000); // ~6.4MB
    const body = `<html><body>${filler}</body></html>`;
    const start = Date.now();
    const out = summarize(body, "html");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("runs in near-linear time on adversarial input, not quadratic (bounded match, not just the cap)", () => {
    // Every "It seems " repetition is a candidate match start with no "."
    // ever following it. Under the old unbounded `[^.]*\.`, each failed
    // candidate rescans to the end of the (20,000-char-capped) string —
    // measured at ~33ms for a 20,000-char body of this shape. The bounded
    // `[^.]{0,300}\.` fails each candidate after at most 300 chars, so this
    // must stay well under that even though the cap alone doesn't change.
    const body = `<html>${"It seems ".repeat(50_000)}</html>`; // truncated to 20,000 chars by the cap either way
    const start = Date.now();
    const out = summarize(body, "html");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(20);
    expect(typeof out).toBe("string");
  });

  it("documents a known limit, not a requirement: a sentence beyond the length cap is not found", () => {
    // This is the length cap's trade-off, not a design goal. It exists as
    // defense-in-depth against pathological input *size* (bytes processed),
    // independent of the match-bounding fix above, which already makes the
    // regex itself safe regardless of cap size. If the cap is ever raised
    // or removed (e.g. because real error pages turn out to be bigger than
    // expected), this test's expectation should change with it — it is not
    // asserting that finding sentences beyond 20,000 chars is desirable.
    const filler = "x".repeat(30_000); // beyond the 20,000-char cap
    const body = `<html>${filler} It seems you don't have access to this document.</html>`;
    const out = summarize(body, "html");
    expect(out).not.toContain("It seems");
  });

  it("still finds the sentence when it's within the bounded prefix", () => {
    const body = `<html><h1>Hmmm...</h1><p>It seems you don't have access to this document.</p>${"x".repeat(5000)}</html>`;
    expect(summarize(body, "html")).toBe("It seems you don't have access to this document.");
  });
});

// ---------------------------------------------------------------------------
// (d) Timeout behavior.
// ---------------------------------------------------------------------------
describe("timeout behavior", () => {
  it("surfaces a legible UpstreamError, not a raw AbortError, when every attempt times out", async () => {
    vi.useFakeTimers();
    const timeoutErr = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const f = vi.fn(async () => {
      throw timeoutErr;
    });
    const t: TransportDef = { ...base, retry: { attempts: 3, on: ["429", "5xx", "truncated"], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);
    const p = http.request("https://x.test/a", {});
    p.catch(() => {}); // observed below; suppresses a spurious unhandledRejection while timers advance
    await vi.advanceTimersByTimeAsync(8000);
    let caught: unknown;
    try {
      await p;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect(caught).not.toBe(timeoutErr);
    expect((caught as Error).message).toMatch(/timed out|timeout/i);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("is not silently swallowed: a timeout on one attempt is retried, not ignored", async () => {
    vi.useFakeTimers();
    const timeoutErr = new DOMException("timeout", "TimeoutError");
    const f = vi.fn()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce(res(200, '{"ok":true}'));
    const t: TransportDef = { ...base, retry: { attempts: 2, on: ["429", "5xx", "truncated"], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);
    const p = http.request("https://x.test/a", {});
    await vi.advanceTimersByTimeAsync(8000);
    const out = await p;
    expect(out.data).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
  });
});
