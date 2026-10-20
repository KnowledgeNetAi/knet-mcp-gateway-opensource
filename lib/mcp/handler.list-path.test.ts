import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { loadCatalog } from "@/lib/config/load";
import { handleMcpRequest, type HandlerDeps } from "@/lib/mcp/handler";
import { runTool } from "@/lib/adapters/run";
import type { AdapterContext } from "@/lib/adapters/types";
import type { Principal } from "@/lib/types";

/**
 * B2 (Task 12 final review): `lib/mcp/handler.ts`'s list branch built the response envelope
 * as `{ items: filterFields(rawRecord.items, allow), truncated, ... }` — but nothing in the
 * whole suite ever exercised that call with a non-pass-through allowlist against the real
 * runTool/catalog wiring:
 *
 *  - `lib/policy/security.test.ts` calls `filterFields` directly, never through the handler.
 *  - `lib/mcp/handler.test.ts`'s fixture tools have no `list` block at all, so every field-leak
 *    test there hits the single-record branch (`filterFields(raw, allow)`), never the list one.
 *  - The one list-tool handler test (`[fix round 2, C]`) grants `allow: ["*"]`, which makes
 *    `filterFields` a pass-through regardless of whether the call happened at all.
 *
 * Most real list tools declare `list`, so this gap covers most tools a deployment serves. This
 * test goes through the REAL committed catalog (`orgs/demo/helloworld`), a `viewer` principal,
 * and the REAL `runTool` (not a stub), with only `ctx.http` faked to return a poisoned upstream
 * payload — as close to the real request path as a unit test can get without calling the
 * upstream.
 *
 * Mutating `lib/mcp/handler.ts`'s list branch from
 *   `items: filterFields(rawRecord.items, allow)`
 * to
 *   `items: rawRecord.items`
 * must make this test fail. (Verified directly — see the final-fix-report.)
 */
describe("B2: field filtering on the list-result path (real catalog, real runTool)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // The demo app declares `auth.type: "none"`, so no token is minted. Any real network call
    // from this test is a bug, and the stub makes it fail loudly instead of reaching the
    // public upstream from CI.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("this test must not reach the network");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("does not leak forbidden user fields through user_search's list envelope for viewer", async () => {
    const catalog = loadCatalog(join(process.cwd(), "orgs"));
    const entry = catalog.get("demo/helloworld")!;
    expect(entry).toBeTruthy();

    const principal: Principal = { userId: "u1", orgId: "o1", orgSlug: "demo", roles: ["viewer"], oauthResource: null };

    // A poisoned page: alongside the fields viewer's committed allowlist grants (id, names,
    // email, company name/title/department), the upstream also returns fields viewer must
    // never see.
    const poisonedPage = {
      users: [
        {
          id: 1,
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.com",
          ssn: "900-00-0000",
          password: "hunter2",
          bank: { cardNumber: "4111111111111111", iban: "GB00TEST" },
          company: { name: "Analytical Engines", title: "Programmer", address: { city: "Marylebone" } },
        },
      ],
      total: 1,
      skip: 0,
      limit: 50,
    };

    const deps: HandlerDeps = {
      catalog,
      authenticate: async () => principal,
      runTool,
      audit: async () => {},
      buildContext: async (e) =>
        ({
          http: { request: async () => ({ status: 200, data: poisonedPage, raw: JSON.stringify(poisonedPage) }) },
          secret: async () => "fake-secret",
          config: e.config,
          log: () => {},
        }) satisfies AdapterContext,
    };

    const res = await handleMcpRequest({
      orgSlug: "demo",
      appSlug: null,
      apiKey: "kngw_demo_x",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "helloworld_user_search", arguments: { query: "Ada" } },
      },
      deps,
      issuer: "https://gw.example.com",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const text = body.result.content[0].text as string;

    expect(text).not.toContain("ssn");
    expect(text).not.toContain("password");
    expect(text).not.toContain("cardNumber");
    expect(text).not.toContain("Marylebone");
    // Sanity: this is a filtering fix, not a "drop the whole result" regression — data
    // viewer IS allowed to see must still come through.
    expect(text).toContain("Lovelace");
    expect(text).toContain("Analytical Engines");
  });
});
