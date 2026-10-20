import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getUpstreamToken } from "@/lib/adapters/auth";
import type { AdapterContext } from "@/lib/adapters/types";
import type { AppEntry } from "@/lib/types";

/**
 * `getUpstreamToken` caches per `${org}/${app}` for the life of the process,
 * so every test here uses a distinct org — otherwise the second test in the
 * file would be served the first one's token and assert nothing.
 */
function entryFor(
  org: string,
  auth: Record<string, unknown>,
): AppEntry {
  return {
    org,
    app: "demo",
    config: {
      app: "demo",
      displayName: "Demo",
      baseUrl: "https://api.test/v1",
      auth,
      transport: {
        minIntervalMs: 0,
        timeoutMs: 5000,
        retry: { attempts: 1, on: [], respectRetryAfter: false },
        errors: { format: "json" },
      },
      tools: [],
    },
    roles: { roles: {} },
  } as unknown as AppEntry;
}

const clientCredentials = {
  type: "oauth2_client_credentials",
  tokenUrl: "https://api.test/token",
  bodyFormat: "json",
  secrets: { client_id: "o/demo/client_id", client_secret: "o/demo/client_secret" },
  expiry: { field: "expires_in", coerce: "number", skewSeconds: 60 },
};

const refreshToken = {
  type: "oauth2_refresh_token",
  tokenUrl: "https://api.test/oauth/v1/token",
  bodyFormat: "form",
  secrets: {
    client_id: "o/demo/client_id",
    client_secret: "o/demo/client_secret",
    refresh_token: "o/demo/refresh_token",
  },
  expiry: { field: "expires_in", coerce: "number", skewSeconds: 60 },
};

function ctxFor(entry: AppEntry): AdapterContext {
  return {
    http: {
      request: async () => {
        throw new Error("the token-mint path must not use ctx.http");
      },
    },
    // Each secret resolves to its own vault path, so a body assertion can tell
    // which declared secret landed under which parameter name.
    secret: async (path) => `value-of:${path}`,
    config: entry.config,
    log: () => {},
  };
}

let bodies: Array<{ url: string; contentType: string; body: string }>;
const originalFetch = global.fetch;

beforeEach(() => {
  bodies = [];
  global.fetch = (async (url: string, init: RequestInit) => {
    bodies.push({
      url,
      contentType: (init.headers as Record<string, string>)["Content-Type"],
      body: String(init.body),
    });
    return new Response(
      JSON.stringify({ access_token: "minted", refresh_token: "rotated", expires_in: 1800 }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("getUpstreamToken grant selection", () => {
  it("sends grant_type=client_credentials for a client-credentials app", async () => {
    const entry = entryFor("grant-cc", clientCredentials);
    await getUpstreamToken(entry, ctxFor(entry));
    const parsed = JSON.parse(bodies[0].body) as Record<string, string>;
    expect(parsed.grant_type).toBe("client_credentials");
    expect(parsed.client_id).toBe("value-of:o/demo/client_id");
    expect(bodies[0].contentType).toBe("application/json");
  });

  it("sends grant_type=refresh_token, form-encoded, with the refresh token under its own name", async () => {
    const entry = entryFor("grant-rt", refreshToken);
    const token = await getUpstreamToken(entry, ctxFor(entry));
    expect(token).toBe("minted");

    expect(bodies[0].contentType).toBe("application/x-www-form-urlencoded");
    const parsed = new URLSearchParams(bodies[0].body);
    expect(parsed.get("grant_type")).toBe("refresh_token");
    expect(parsed.get("client_id")).toBe("value-of:o/demo/client_id");
    expect(parsed.get("client_secret")).toBe("value-of:o/demo/client_secret");
    // The point of the "every declared secret goes into the body under its own
    // name" rule: the refresh grant needed no special case in auth.ts at all.
    expect(parsed.get("refresh_token")).toBe("value-of:o/demo/refresh_token");
  });

  it("ignores a rotated refresh_token in the response rather than writing it back", async () => {
    // The stub above answers with `refresh_token: "rotated"`. Nothing in this
    // module may persist that: the stored credential is git-described,
    // console-written state, and a silent write-back would make the running
    // gateway the only thing that knows the real value. A provider that does
    // rotate needs a deliberate change here, not an accident.
    const entry = entryFor("grant-rotate", refreshToken);
    await getUpstreamToken(entry, ctxFor(entry));
    expect(bodies).toHaveLength(1);
    const second = entryFor("grant-rotate-2", refreshToken);
    await getUpstreamToken(second, ctxFor(second));
    const parsed = new URLSearchParams(bodies[1].body);
    expect(parsed.get("refresh_token")).toBe("value-of:o/demo/refresh_token");
  });
});
