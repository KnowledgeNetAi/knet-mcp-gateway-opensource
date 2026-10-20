import { describe, it, expect, vi } from "vitest";
import { createHttp } from "@/lib/http/client";
import { UpstreamError } from "@/lib/http/errors";
import type { TransportDef } from "@/lib/types";

// Writes must not be retried on a 5xx: the mutation may have already been applied upstream, and
// retrying would double-submit it. A 429 is still safe to retry — the request was rejected, not
// applied. `request()`'s third argument (`opts.retryOn`) lets a caller narrow the retryable set
// for one call without touching the app's `transport.retry.on` config, which every other call
// site (reads) keeps relying on unchanged.

const transport: TransportDef = {
  minIntervalMs: 0,
  timeoutMs: 5000,
  retry: { attempts: 3, on: ["429", "5xx"], respectRetryAfter: false },
  errors: { format: "html" },
};

const res = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

describe("createHttp — per-call retryOn override", () => {
  it("does not retry a 500 when the call narrows retryOn to just 429", async () => {
    const f = vi.fn(async () => res(500, "server exploded"));
    const http = createHttp(transport, f as unknown as typeof fetch);

    await expect(http.request("https://x.test/write", {}, { retryOn: ["429"] })).rejects.toThrow(UpstreamError);
    // Exactly one fetch: the 5xx must not be retried, because config says "5xx" is retryable
    // but this call's override says only "429" is.
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("still retries a 429 when the call narrows retryOn to just 429", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(429, "slow down"))
      .mockResolvedValueOnce(res(200, "{}"));
    const http = createHttp(transport, f as unknown as typeof fetch);

    const out = await http.request("https://x.test/write", {}, { retryOn: ["429"] });
    expect(out.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("an explicit empty retryOn retries nothing — not even a 429", async () => {
    const f = vi.fn(async () => res(429, "slow down"));
    const http = createHttp(transport, f as unknown as typeof fetch);

    await expect(http.request("https://x.test/write", {}, { retryOn: [] })).rejects.toThrow(UpstreamError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("an explicit empty retryOn also stops a 500 from being retried", async () => {
    const f = vi.fn(async () => res(500, "server exploded"));
    const http = createHttp(transport, f as unknown as typeof fetch);

    await expect(http.request("https://x.test/write", {}, { retryOn: [] })).rejects.toThrow(UpstreamError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("with no opts argument at all, behavior is unchanged: driven entirely by transport.retry.on", async () => {
    // This is the backwards-compatibility guard: every existing call site passes only
    // (url, init), and must keep retrying a 5xx exactly as it does today.
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(500, "server exploded"))
      .mockResolvedValueOnce(res(200, "{}"));
    const http = createHttp(transport, f as unknown as typeof fetch);

    const out = await http.request("https://x.test/read", {});
    expect(out.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a caller-supplied token is case-insensitive, matching config's own normalization", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(500, "server exploded"))
      .mockResolvedValueOnce(res(200, "{}"));
    const http = createHttp(transport, f as unknown as typeof fetch);

    const out = await http.request("https://x.test/write", {}, { retryOn: ["5XX"] });
    expect(out.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("opts.retryOn does not mutate the app's transport config", async () => {
    const f = vi.fn(async () => res(500, "server exploded"));
    const http = createHttp(transport, f as unknown as typeof fetch);

    const before = JSON.parse(JSON.stringify(transport));
    await expect(http.request("https://x.test/write", {}, { retryOn: ["429"] })).rejects.toThrow(UpstreamError);
    expect(transport).toEqual(before);
    // Specifically, the config's own retry.on array must still be the original reference/value.
    expect(transport.retry.on).toEqual(["429", "5xx"]);
  });
});
