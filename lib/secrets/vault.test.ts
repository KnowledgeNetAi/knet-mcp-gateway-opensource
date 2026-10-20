import util from "node:util";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSecretReader, vaultFetcher, type SecretFetcher } from "@/lib/secrets/vault";

// A stateful, per-test-configurable stand-in for the `.rpc()` call.
// `vi.hoisted` is required because `vi.mock` factories are hoisted above
// imports, so the mock can't close over an ordinary module-scope `const`
// declared after it.
//
// This mocks `.rpc()` rather than a `.schema("vault").from(...)` chain
// deliberately: reading `vault.decrypted_secrets` over the Data API cannot
// work, because PostgREST exposes only `public` and `graphql_public` and
// answers `PGRST106 Invalid schema: vault`. The real read goes through the
// `public.read_vault_secret` SECURITY DEFINER function instead. Restoring a
// `.schema("vault")` chain here would make these tests pass against code
// that fails against every real Supabase project.
const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

/**
 * Asserts a caught value never exposes `secret`, through any of: its own
 * `.message` (via `String()`/`.toString()`), `JSON.stringify` (which
 * surfaces extra enumerable own properties but not `.message` or `.cause`),
 * or a deep `util.inspect` (which walks `.cause` chains, `.stack`, getters,
 * and non-enumerable/hidden properties — the same traversal Node's
 * uncaught-exception printer and pino's `err` serializer perform).
 */
function assertNeverLeaks(caught: unknown, secret: string) {
  expect(caught).toBeDefined();
  expect(String(caught)).not.toMatch(secret);
  expect(JSON.stringify(caught)).not.toMatch(secret);
  expect(
    util.inspect(caught, { depth: null, showHidden: true, getters: true })
  ).not.toMatch(secret);
}

async function catchRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject");
}

describe("createSecretReader", () => {
  it("returns the secret value", async () => {
    const read = createSecretReader(async () => "s3cret");
    expect(await read("contoso/servicefusion/client_secret")).toBe("s3cret");
  });

  it("caches within the TTL", async () => {
    const fetcher = vi.fn(async () => "v1");
    const read = createSecretReader(fetcher, 60_000);
    await read("a"); await read("a");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refetches after the TTL expires, serving the new value (not the stale one)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetcher = vi.fn(async () => (++calls === 1 ? "v1" : "v2"));
    const read = createSecretReader(fetcher, 1000);

    expect(await read("a")).toBe("v1");
    vi.advanceTimersByTime(1500);
    expect(await read("a")).toBe("v2");

    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("evicts an expired entry instead of leaving it resident until (if ever) overwritten", async () => {
    vi.useFakeTimers();
    // The cache is private to createSecretReader's closure, so there's no
    // public way to inspect its contents directly. Spying on the shared
    // Map.prototype.delete lets us observe eviction without breaking that
    // encapsulation. (The in-flight de-dup map also calls `.delete` on
    // settle, so we count from a baseline taken after the first read rather
    // than asserting zero calls.)
    const deleteSpy = vi.spyOn(Map.prototype, "delete");
    try {
      const read = createSecretReader(vi.fn(async () => "v1"), 1000);
      await read("a");
      const callsAfterFirstRead = deleteSpy.mock.calls.length;

      vi.advanceTimersByTime(1500);
      // read() evicts the expired cache entry synchronously, before it ever
      // awaits the refetch — so this checkpoint, taken before awaiting the
      // returned promise, isolates that eviction from the in-flight map's
      // later post-settle cleanup.
      const pending = read("a");
      expect(deleteSpy.mock.calls.length).toBe(callsAfterFirstRead + 1);
      expect(deleteSpy).toHaveBeenLastCalledWith("a");
      await pending;
    } finally {
      deleteSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("throws a path-identifying error when the secret is missing", async () => {
    const read = createSecretReader(async () => null);
    await expect(read("contoso/servicefusion/client_secret"))
      .rejects.toThrow(/contoso\/servicefusion\/client_secret/);
  });

  it("never puts the secret value in the error message", async () => {
    const read = createSecretReader(async () => null);
    await expect(read("p")).rejects.not.toThrow(/s3cret/);
  });
});

describe("createSecretReader — escape and cache attacks", () => {
  it("does not leak the secret value when the fetcher itself throws", async () => {
    const read = createSecretReader(async () => {
      throw new Error("upstream exploded while holding s3cret-value");
    });
    const caught = await catchRejection(read("p"));
    assertNeverLeaks(caught, "s3cret-value");
  });

  it("does not leak the secret value through JSON.stringify or a deep inspect of the rejection", async () => {
    const read = createSecretReader(async () => {
      // A misbehaving fetcher that attaches the secret as an extra
      // enumerable property instead of (or in addition to) the message.
      throw Object.assign(new Error("boom"), { detail: "s3cret-value" });
    });
    const caught = await catchRejection(read("p"));
    assertNeverLeaks(caught, "s3cret-value");
  });

  it("classifies an unrecognized error code without ever echoing it", async () => {
    // A hostile `.code` — this must never reach the message: it is looked
    // up as an allowlist key, not validated-by-shape-and-interpolated.
    const read = createSecretReader(async () => {
      throw Object.assign(new Error("boom"), { code: "s3cret-value" });
    });
    const caught = await catchRejection(read("p"));
    assertNeverLeaks(caught, "s3cret-value");
    await expect(read("p")).rejects.toThrow(/\(unknown\)/);
  });

  it("classifies a recognized error code into the message", async () => {
    const read = createSecretReader(async () => {
      throw Object.assign(new Error("insufficient_privilege"), { code: "42501" });
    });
    await expect(read("p")).rejects.toThrow(/\(permission\)/);
  });

  it("does not classify an inherited `code` as this error's own", async () => {
    // `code` exists via the prototype chain, not as an own property — it
    // must not classify as if this specific error carried it.
    const proto = { code: "42501" };
    const err = Object.assign(Object.create(proto), { message: "boom" });
    const read = createSecretReader(async () => {
      throw err;
    });
    await expect(read("p")).rejects.toThrow(/\(unknown\)/);
  });

  it("falls through to 'unknown' — without leaking or propagating the throw — when reading `.code` throws (getter)", async () => {
    const err = new Error("boom");
    Object.defineProperty(err, "code", {
      get() {
        throw new Error("trap s3cret-value");
      },
      enumerable: true,
      configurable: true,
    });
    const read = createSecretReader(async () => {
      throw err;
    });
    const caught = await catchRejection(read("p"));
    assertNeverLeaks(caught, "s3cret-value");
    expect(String(caught)).toMatch(/\(unknown\)/);
  });

  it("falls through to 'unknown' — without leaking or propagating the throw — when reading `.code` throws (Proxy get trap)", async () => {
    // The target must actually carry an own `code` property so
    // Object.hasOwn's existence check (which does not invoke the `get`
    // trap) passes and the read genuinely reaches the trap below —
    // otherwise the hasOwn gate would short-circuit before ever touching
    // this trap, and the test wouldn't exercise the throw at all.
    const target = Object.assign(new Error("boom"), { code: "placeholder" });
    const proxied = new Proxy(target, {
      get(t, prop, receiver) {
        if (prop === "code") throw new Error("trap s3cret-value");
        return Reflect.get(t, prop, receiver);
      },
    });
    const read = createSecretReader(async () => {
      throw proxied;
    });
    const caught = await catchRejection(read("p"));
    assertNeverLeaks(caught, "s3cret-value");
    expect(String(caught)).toMatch(/\(unknown\)/);
  });

  it("keeps distinct cache entries for a path and its prefix", async () => {
    const fetcher = vi.fn(async (path: string) => (path === "a" ? "va" : "vab"));
    const read = createSecretReader(fetcher, 60_000);
    expect(await read("a")).toBe("va");
    expect(await read("ab")).toBe("vab");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent in-flight fetches for the same path", async () => {
    let resolveFetch!: (value: string) => void;
    let calls = 0;
    const fetcher: SecretFetcher = () => {
      calls++;
      return new Promise<string>((resolve) => {
        resolveFetch = resolve;
      });
    };
    const read = createSecretReader(fetcher, 60_000);

    const p1 = read("a");
    const p2 = read("a");
    resolveFetch("v1");

    expect(await p1).toBe("v1");
    expect(await p2).toBe("v1");
    expect(calls).toBe(1);
  });

  it("does not poison the cache when a fetch transiently fails", async () => {
    let calls = 0;
    const fetcher: SecretFetcher = async () => {
      calls++;
      if (calls === 1) throw new Error("transient outage");
      return "v1";
    };
    const read = createSecretReader(fetcher, 60_000);

    await expect(read("a")).rejects.toThrow();
    expect(await read("a")).toBe("v1");
    expect(calls).toBe(2);
  });
});

describe("vaultFetcher", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  // `read_vault_secret` returns `text`, so PostgREST hands back the scalar
  // itself — not a `{ decrypted_secret }` row as the old direct-select did.
  it("returns the decrypted secret on a successful read", async () => {
    rpcMock.mockResolvedValue({ data: "s3cret", error: null });
    expect(await vaultFetcher("contoso/servicefusion/client_secret")).toBe("s3cret");
  });

  it("passes the secret path as the function's p_name argument", async () => {
    rpcMock.mockResolvedValue({ data: "s3cret", error: null });
    await vaultFetcher("contoso/servicefusion/client_secret");
    expect(rpcMock).toHaveBeenCalledWith("read_vault_secret", {
      p_name: "contoso/servicefusion/client_secret",
    });
  });

  it("returns null when no secret matches (feeds the reader's fail-closed path)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    expect(await vaultFetcher("contoso/servicefusion/client_secret")).toBeNull();
  });

  it("throws, without leaking, when the query resolves with an error", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: "denied while touching s3cret-vault-value", code: "42501" },
    });
    const caught = await catchRejection(
      vaultFetcher("contoso/servicefusion/client_secret")
    );
    assertNeverLeaks(caught, "s3cret-vault-value");
    expect(String(caught)).toMatch(/\(permission\)/);
  });

  it("does not leak the secret value when the underlying call throws", async () => {
    rpcMock.mockRejectedValue(
      new Error("connection reset while returning s3cret-vault-value")
    );
    const caught = await catchRejection(
      vaultFetcher("contoso/servicefusion/client_secret")
    );
    assertNeverLeaks(caught, "s3cret-vault-value");
  });

  it("carries its classification through createSecretReader's own wrap instead of losing it", async () => {
    rpcMock.mockRejectedValue(
      Object.assign(new Error("denied"), { code: "42501" })
    );
    const read = createSecretReader(vaultFetcher, 60_000);
    await expect(read("contoso/servicefusion/client_secret")).rejects.toThrow(
      /\(permission\)/
    );
  });
});
