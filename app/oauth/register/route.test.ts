import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/oauth/register/route";

// `vi.hoisted` is required because `vi.mock` factories are hoisted above
// imports, so the mock can't close over an ordinary module-scope `const`
// declared after it (same pattern as lib/audit/log.test.ts and
// lib/secrets/vault.test.ts).
const { insertMock, fromMock } = vi.hoisted(() => {
  const insertMock = vi.fn(async (_payload: Record<string, unknown>) => ({
    error: null as { message: string } | null,
  }));
  const fromMock = vi.fn((_table: string) => ({ insert: insertMock }));
  return { insertMock, fromMock };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: fromMock }),
}));

function registerRequest(
  body: unknown,
  { ip = "203.0.113.1" }: { ip?: string } = {},
): NextRequest {
  return new NextRequest("https://gw.example.com/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("POST /oauth/register", () => {
  beforeEach(() => {
    fromMock.mockClear();
    insertMock.mockClear();
    insertMock.mockImplementation(async () => ({ error: null }));
  });

  it("returns 201 with an oc_-prefixed client_id for a valid registration", async () => {
    const res = await POST(
      registerRequest(
        { client_name: "probe", redirect_uris: ["https://example.com/cb"] },
        { ip: "203.0.113.1" },
      ),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.client_id).toMatch(/^oc_/);
    expect(json.client_name).toBe("probe");
    expect(json.redirect_uris).toEqual(["https://example.com/cb"]);
    expect(json.token_endpoint_auth_method).toBe("none");
    expect(typeof json.client_id_issued_at).toBe("number");
    expect(fromMock).toHaveBeenCalledWith("oauth_clients");
  });

  it("rejects an http:// non-localhost redirect_uri with invalid_redirect_uri", async () => {
    const res = await POST(
      registerRequest(
        { client_name: "probe", redirect_uris: ["http://example.com/cb"] },
        { ip: "203.0.113.2" },
      ),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_redirect_uri");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("rejects a redirect_uri containing a fragment", async () => {
    const res = await POST(
      registerRequest(
        { client_name: "probe", redirect_uris: ["https://example.com/cb#frag"] },
        { ip: "203.0.113.3" },
      ),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_redirect_uri");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("returns 429 with a retry-after header on a 6th registration from one IP inside the window", async () => {
    const ip = "203.0.113.4";
    const body = { client_name: "probe", redirect_uris: ["https://example.com/cb"] };

    for (let i = 0; i < 5; i++) {
      const res = await POST(registerRequest(body, { ip }));
      expect(res.status).toBe(201);
    }

    const sixth = await POST(registerRequest(body, { ip }));
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("retry-after")).not.toBeNull();
    const retryAfter = Number(sixth.headers.get("retry-after"));
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    const json = await sixth.json();
    expect(json.error).toBe("rate_limited");
  });
});
