import { describe, it, expect, vi } from "vitest";
import { createHttp, summarize } from "@/lib/http/client";
import { UpstreamError } from "@/lib/http/errors";
import type { TransportDef } from "@/lib/types";

const transport: TransportDef = {
  minIntervalMs: 0,
  timeoutMs: 5000,
  retry: { attempts: 3, on: ["429", "5xx", "truncated"], respectRetryAfter: false },
  errors: { format: "html" },
};

const res = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

describe("summarize", () => {
  it("extracts the sentence from a Service Fusion HTML error page", () => {
    const html = "<html><body><h1>Hmmm...</h1><p>It seems you don't have access to this document.</p></body></html>";
    expect(summarize(html, "html")).toBe("It seems you don't have access to this document.");
  });
  it("prefers the explanatory sentence over the Hmmm heading", () => {
    expect(summarize("<h1>Hmmm...</h1> It seems that the location cannot be found.", "html"))
      .toContain("It seems that the location");
  });
});

describe("createHttp", () => {
  it("never follows an upstream redirect, so stored headers and bodies stay on the upstream", async () => {
    const f = vi.fn(async () => new Response(null, { status: 307, headers: { location: "http://evil.example/steal" } }));
    const http = createHttp(transport, f as unknown as typeof fetch);
    await expect(
      http.request("https://x.test/a", { method: "POST", headers: { "X-Api-Key": "secret" }, body: "{}" }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe("manual");
  });

  it("returns parsed JSON on success", async () => {
    const f = vi.fn(async () => res(200, '{"items":[1]}'));
    const http = createHttp(transport, f as unknown as typeof fetch);
    const out = await http.request("https://x.test/a", {});
    expect(out.data).toEqual({ items: [1] });
  });

  it("retries a 2xx body that will not parse, then succeeds", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(res(200, '{"items":[1'))   // truncated
      .mockResolvedValueOnce(res(200, '{"items":[1]}'));
    const http = createHttp(transport, f as unknown as typeof fetch);
    const out = await http.request("https://x.test/a", {});
    expect(out.data).toEqual({ items: [1] });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("throws rather than returning a short result when truncation persists", async () => {
    const f = vi.fn(async () => res(200, '{"items":[1'));
    const http = createHttp(transport, f as unknown as typeof fetch);
    await expect(http.request("https://x.test/a", {})).rejects.toThrow(/truncated/);
  });

  it("retries a 429", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(res(429, "slow down"))
      .mockResolvedValueOnce(res(200, "{}"));
    const http = createHttp(transport, f as unknown as typeof fetch);
    expect((await http.request("https://x.test/a", {})).status).toBe(200);
  });

  it("surfaces a 403 as a readable UpstreamError", async () => {
    const f = vi.fn(async () => res(403, "<h1>Hmmm...</h1><p>It seems you don't have access to this document.</p>"));
    const http = createHttp(transport, f as unknown as typeof fetch);
    await expect(http.request("https://x.test/jobs", {}))
      .rejects.toThrow(/don't have access/);
  });
});
