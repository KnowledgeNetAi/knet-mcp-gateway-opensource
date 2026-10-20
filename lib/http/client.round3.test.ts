import { describe, it, expect, vi, afterEach } from "vitest";
import { createHttp, summarize } from "@/lib/http/client";
import { UpstreamError } from "@/lib/http/errors";
import type { TransportDef } from "@/lib/types";

// Round-3 review fixes. See
// .superpowers/sdd/2026-09-12-gateway-phase-1/task-8-report.md ("Round 3")
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

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Finding A (Important) — decodeEntities must not throw RangeError out of
// summarize()/createHttp() on an out-of-range numeric character reference.
// ---------------------------------------------------------------------------
describe("decodeEntities guards invalid code points", () => {
  it("summarize() does not throw on an out-of-range decimal reference; leaves it as literal text", () => {
    const body = "<p>It seems &#999999999; you don't have access to this document.</p>";
    expect(() => summarize(body, "html")).not.toThrow();
    expect(summarize(body, "html")).toContain("&#999999999;");
  });

  it("summarize() does not throw on an out-of-range hex reference; leaves it as literal text", () => {
    const body = "<p>The requested &#x110000; resource failed.</p>";
    expect(() => summarize(body, "html")).not.toThrow();
    expect(summarize(body, "html")).toContain("&#x110000;");
  });

  it("an out-of-range decimal reference in a real error body surfaces as UpstreamError, not RangeError", async () => {
    const f = vi.fn(async () =>
      res(403, "<h1>Hmmm...</h1><p>It seems &#999999999; you don't have access to this document.</p>")
    );
    const t: TransportDef = { ...base, retry: { attempts: 1, on: [], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);
    let caught: unknown;
    try {
      await http.request("https://x.test/jobs", {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).status).toBe(403);
  });

  it("an out-of-range hex reference in a real error body surfaces as UpstreamError, not RangeError", async () => {
    const f = vi.fn(async () =>
      res(500, "<h1>Hmmm...</h1><p>The requested &#x110000; resource failed.</p>")
    );
    const t: TransportDef = { ...base, retry: { attempts: 1, on: [], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);
    let caught: unknown;
    try {
      await http.request("https://x.test/jobs", {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Finding B (Important) — a caller-initiated abort must not be retried. The
// gateway must release the request immediately when its own MCP client
// disconnects, not hold it through the full backoff ladder and then report
// the cancellation as an upstream failure.
// ---------------------------------------------------------------------------
describe("caller abort is not retried", () => {
  function abortableFetch() {
    return vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      if (signal.aborted) {
        throw new DOMException("This operation was aborted", "AbortError");
      }
      return new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("This operation was aborted", "AbortError")),
          { once: true }
        );
      });
    });
  }

  it("rethrows immediately when the caller's own AbortSignal fires — not retried, not reported as an UpstreamError", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const f = abortableFetch();
    const t: TransportDef = { ...base, retry: { attempts: 5, on: ["429", "5xx", "truncated"], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);

    const p = http.request("https://x.test/a", { signal: controller.signal });
    p.catch(() => {});
    controller.abort();
    // If this were (wrongly) retried, fake-advancing past the whole backoff
    // ladder (500+1000+2000+4000=7500ms) would be needed for it to resolve.
    await vi.advanceTimersByTimeAsync(20_000);

    let caught: unknown;
    try {
      await p;
    } catch (err) {
      caught = err;
    }
    expect(f).toHaveBeenCalledTimes(1);
    expect(caught).not.toBeInstanceOf(UpstreamError);
    expect((caught as DOMException).name).toBe("AbortError");
  });

  it("still retries a genuine per-attempt timeout (no caller signal involved)", async () => {
    vi.useFakeTimers();
    const timeoutErr = new DOMException("timed out", "TimeoutError");
    const f = vi.fn()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce(res(200, '{"ok":true}'));
    const t: TransportDef = { ...base, retry: { attempts: 2, on: ["429", "5xx", "truncated"], respectRetryAfter: false } };
    const http = createHttp(t, f as unknown as typeof fetch);
    const p = http.request("https://x.test/a", {}); // no caller-supplied signal
    await vi.advanceTimersByTimeAsync(8000);
    const out = await p;
    expect(out.data).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
  });
});
