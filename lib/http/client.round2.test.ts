import { describe, it, expect, vi, afterEach } from "vitest";
import { createHttp } from "@/lib/http/client";
import { UpstreamError } from "@/lib/http/errors";
import type { TransportDef } from "@/lib/types";

// Round-2 review fixes. Each describe block corresponds to one numbered
// finding from the review of the first round. See
// .superpowers/sdd/2026-09-12-gateway-phase-1/task-8-report.md for the full
// writeup of what was wrong and why.

const base: TransportDef = {
  minIntervalMs: 0,
  timeoutMs: 5000,
  retry: { attempts: 3, on: ["429", "5xx", "truncated"], respectRetryAfter: false },
  errors: { format: "html" },
};

const res = (status: number, body: string, headers: Record<string, string> = {}) =>
  // The Response constructor throws if a body (even "") is given for a
  // null-body status (204/205/304) — a fetch/undici-internals quirk, not
  // something a real upstream response is bound by. Pass null there so the
  // test helper can still express "204 with an empty body" naturally.
  new Response(status === 204 || status === 205 ? null : body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Finding 1 (CRITICAL) — a zero-byte 2xx body must not silently become
// `data: null`. Only 204/205 legitimately have no body; any other status
// with a zero-byte body is the most complete truncation there is.
// ---------------------------------------------------------------------------
describe("zero-byte response bodies", () => {
  it("a 204 No Content legitimately returns null data without retrying", async () => {
    const f = vi.fn(async () => res(204, ""));
    const http = createHttp(base, f as unknown as typeof fetch);
    const out = await http.request("https://x.test/a", {});
    expect(out.data).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a 205 Reset Content legitimately returns null data without retrying", async () => {
    const f = vi.fn(async () => res(205, ""));
    const http = createHttp(base, f as unknown as typeof fetch);
    const out = await http.request("https://x.test/a", {});
    expect(out.data).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a 200 with a zero-byte body is treated as a truncation and retried, then succeeds", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(res(200, "")) // connection cut before the first byte
      .mockResolvedValueOnce(res(200, '{"items":[1]}'));
    const http = createHttp(base, f as unknown as typeof fetch);
    const out = await http.request("https://x.test/a", {});
    expect(out.data).toEqual({ items: [1] });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a 200 with a persistently zero-byte body throws rather than returning empty data", async () => {
    const f = vi.fn(async () => res(200, ""));
    const http = createHttp(base, f as unknown as typeof fetch);
    await expect(http.request("https://x.test/a", {})).rejects.toThrow(/truncated/);
    expect(f).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Finding 4 (Important) — throttle() must reserve the next slot synchronously,
// before any await, or concurrent callers all read the same stale `lastAt`
// and the spacing collapses to a no-op after the first tick.
// ---------------------------------------------------------------------------
describe("throttle concurrency", () => {
  it("spaces concurrent requests by minIntervalMs even when they start at once", async () => {
    vi.useFakeTimers();
    const callOffsets: number[] = [];
    const start = Date.now();
    const f = vi.fn(async () => {
      callOffsets.push(Date.now() - start);
      return res(200, "{}");
    });
    const t: TransportDef = {
      ...base,
      minIntervalMs: 300,
      retry: { attempts: 1, on: [], respectRetryAfter: false },
    };
    const http = createHttp(t, f as unknown as typeof fetch);

    const requests = Array.from({ length: 6 }, () => http.request("https://x.test/a", {}));
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all(requests);

    expect(callOffsets).toEqual([0, 300, 600, 900, 1200, 1500]);
  });
});

// ---------------------------------------------------------------------------
// Finding 5 (Important) — the fetch-level try/catch must only retry genuine
// timeout/network failures. A programming error (bad URL, bad request init)
// must propagate as itself — not be retried five times and reported as an
// UpstreamError with its type and stack destroyed.
// ---------------------------------------------------------------------------
describe("narrowed fetch-failure catch", () => {
  it("does not retry a programming error and rethrows it as-is", async () => {
    vi.useFakeTimers();
    const programmingError = new TypeError("Failed to parse URL from not-a-url");
    const f = vi.fn(async () => {
      throw programmingError;
    });
    const t: TransportDef = { ...base, retry: { attempts: 5, on: ["429", "5xx", "truncated"], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);

    const p = http.request("https://x.test/a", {});
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(p).rejects.toBe(programmingError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("still retries a genuine per-attempt timeout (TimeoutError)", async () => {
    vi.useFakeTimers();
    const timeoutErr = new DOMException("timed out", "TimeoutError");
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

  it("still retries a genuine network failure (a TypeError with a populated cause)", async () => {
    vi.useFakeTimers();
    const networkErr = new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    const f = vi.fn()
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce(res(200, '{"ok":true}'));
    const t: TransportDef = { ...base, retry: { attempts: 2, on: ["429", "5xx", "truncated"], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);
    const p = http.request("https://x.test/a", {});
    await vi.advanceTimersByTimeAsync(8000);
    const out = await p;
    expect(out.data).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("wraps an exhausted timeout as an UpstreamError that preserves the original as .cause", async () => {
    vi.useFakeTimers();
    const timeoutErr = new DOMException("timed out", "TimeoutError");
    const f = vi.fn(async () => {
      throw timeoutErr;
    });
    const t: TransportDef = { ...base, retry: { attempts: 2, on: ["429", "5xx", "truncated"], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);
    const p = http.request("https://x.test/a", {});
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(8000);
    let caught: unknown;
    try {
      await p;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).cause).toBe(timeoutErr);
  });
});

// ---------------------------------------------------------------------------
// Finding 6 (Important) — HTML entities in the error body must be decoded
// before matching, or the "decoded sentence, never raw markup" constraint is
// violated by the literal entity text leaking through.
// ---------------------------------------------------------------------------
describe("summarize decodes HTML entities", () => {
  it("decodes &#39; so the apostrophe in the real Service Fusion sentence isn't left as markup", async () => {
    const f = vi.fn(async () =>
      res(403, "<h1>Hmmm...</h1><p>It seems you don&#39;t have access to this document.</p>")
    );
    const http = createHttp(base, f as unknown as typeof fetch);
    await expect(http.request("https://x.test/jobs", {}))
      .rejects.toThrow("It seems you don't have access to this document.");
  });

  it("decodes &amp; &lt; &gt; &quot; &nbsp; &rsquo;", async () => {
    const { summarize } = await import("@/lib/http/client");
    const body = "<p>The requested item &amp; friends &lt;tag&gt; &quot;quoted&quot;&nbsp;here&rsquo;s more.</p>";
    const out = summarize(body, "html");
    expect(out).not.toMatch(/&(amp|lt|gt|quot|nbsp|rsquo);/);
    expect(out).toContain("&");
    expect(out).toContain("<tag>");
  });
});

// ---------------------------------------------------------------------------
// Finding 7 (Minor) — the caller's own AbortSignal must not be discarded when
// it's merged with the per-attempt timeout signal.
// ---------------------------------------------------------------------------
describe("caller AbortSignal is preserved", () => {
  it("still reflects the caller's own controller aborting, not just the timeout", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return res(200, "{}");
    });
    const http = createHttp(base, f as unknown as typeof fetch);
    await http.request("https://x.test/a", { signal: controller.signal });

    expect(capturedSignal?.aborted).toBe(false);
    controller.abort();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
