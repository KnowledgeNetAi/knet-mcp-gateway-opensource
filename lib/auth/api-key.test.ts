import { describe, it, expect, vi } from "vitest";

// `node:crypto`'s named exports are non-configurable, so `vi.spyOn(nodeCrypto,
// "timingSafeEqual")` throws ("Cannot redefine property"). Mocking the whole module (kept
// otherwise identical via `importOriginal`, so `createHash`/`randomBytes` stay real) is the
// only way to observe calls to `timingSafeEqual` without changing what it actually computes.
// `vi.hoisted` is required because `vi.mock`'s factory runs before this file's own top-level
// statements (including plain `const` declarations) due to hoisting.
const { timingSafeEqualSpy } = vi.hoisted(() => ({ timingSafeEqualSpy: vi.fn() }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  timingSafeEqualSpy.mockImplementation(actual.timingSafeEqual);
  return {
    ...actual,
    timingSafeEqual: (...args: Parameters<typeof actual.timingSafeEqual>) => timingSafeEqualSpy(...args),
  };
});

import { generateApiKey, hashKey, parseKey, authenticateApiKey } from "@/lib/auth/api-key";

describe("api keys", () => {
  it("generates a key carrying the org prefix", () => {
    const { key, prefix } = generateApiKey("contoso");
    expect(key.startsWith("kngw_contoso_")).toBe(true);
    expect(parseKey(key)!.prefix).toBe(prefix);
  });

  it("hashes deterministically and does not store the key", () => {
    const { key, hash } = generateApiKey("acme");
    expect(hashKey(key)).toBe(hash);
    expect(hash).not.toContain(key);
  });

  it("rejects a malformed key", () => {
    expect(parseKey("not-a-key")).toBeNull();
  });

  it("resolves a valid key to a principal with roles", async () => {
    const { key, prefix, hash } = generateApiKey("contoso");
    const p = await authenticateApiKey(key, {
      lookup: async (pf) => pf === prefix
        ? { hash, org_id: "org-1", org_slug: "contoso", user_id: "user-1", revoked_at: null, expires_at: null }
        : null,
      rolesFor: async () => ["field_tech"],
    });
    expect(p).toEqual({ userId: "user-1", orgId: "org-1", orgSlug: "contoso", roles: ["field_tech"], oauthResource: null });
  });

  it("refuses a revoked key", async () => {
    const { key, hash } = generateApiKey("contoso");
    const p = await authenticateApiKey(key, {
      lookup: async () => ({ hash, org_id: "o", org_slug: "contoso", user_id: "u", revoked_at: "2026-01-01", expires_at: null }),
      rolesFor: async () => ["field_tech"],
    });
    expect(p).toBeNull();
  });

  it("refuses a key whose hash does not match", async () => {
    const { key } = generateApiKey("contoso");
    const p = await authenticateApiKey(key, {
      lookup: async () => ({ hash: "wrong", org_id: "o", org_slug: "contoso", user_id: "u", revoked_at: null, expires_at: null }),
      rolesFor: async () => [],
    });
    expect(p).toBeNull();
  });

  it("accepts a manual key whose expires_at is null", async () => {
    const { key, prefix, hash } = generateApiKey("contoso");
    const principal = await authenticateApiKey(key, {
      lookup: async () => ({
        hash,
        org_id: "org-1",
        org_slug: "contoso",
        user_id: "user-1",
        revoked_at: null,
        expires_at: null,
      }),
      rolesFor: async () => ["dispatcher"],
    });
    expect(principal).not.toBeNull();
    expect(principal!.orgSlug).toBe("contoso");
  });

  it("rejects a token whose expires_at has passed", async () => {
    const { key, prefix, hash } = generateApiKey("contoso");
    const principal = await authenticateApiKey(key, {
      lookup: async () => ({
        hash,
        org_id: "org-1",
        org_slug: "contoso",
        user_id: "user-1",
        revoked_at: null,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
      rolesFor: async () => ["dispatcher"],
    });
    expect(principal).toBeNull();
  });

  it("accepts a token whose expires_at is still in the future", async () => {
    const { key, hash } = generateApiKey("contoso");
    const principal = await authenticateApiKey(key, {
      lookup: async () => ({
        hash,
        org_id: "org-1",
        org_slug: "contoso",
        user_id: "user-1",
        revoked_at: null,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
      rolesFor: async () => ["dispatcher"],
    });
    expect(principal).not.toBeNull();
  });

  it("carries an OAuth token's exact resource into the principal", async () => {
    const { key, hash } = generateApiKey("contoso");
    const resource = "https://gw.example.com/mcp/contoso/fieldedge";
    const principal = await authenticateApiKey(key, {
      lookup: async () => ({
        hash,
        org_id: "org-1",
        org_slug: "contoso",
        user_id: "user-1",
        revoked_at: null,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        source: "oauth",
        oauth_resource: resource,
      }),
      rolesFor: async () => ["owner"],
    });
    expect(principal?.oauthResource).toBe(resource);
  });

  it("rejects a live OAuth row with no resource binding", async () => {
    const { key, hash } = generateApiKey("contoso");
    const principal = await authenticateApiKey(key, {
      lookup: async () => ({
        hash,
        org_id: "org-1",
        org_slug: "contoso",
        user_id: "user-1",
        revoked_at: null,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        source: "oauth",
        oauth_resource: null,
      }),
      rolesFor: async () => ["owner"],
    });
    expect(principal).toBeNull();
  });

  it("rejects a row whose expires_at is unparseable rather than trusting it", async () => {
    const { key, hash } = generateApiKey("contoso");
    const principal = await authenticateApiKey(key, {
      lookup: async () => ({
        hash,
        org_id: "org-1",
        org_slug: "contoso",
        user_id: "user-1",
        revoked_at: null,
        expires_at: "not-a-date",
      }),
      rolesFor: async () => ["dispatcher"],
    });
    expect(principal).toBeNull();
  });
});

describe("api keys - constantTimeEquals actually uses a constant-time comparison", () => {
  // "ALSO FOLD IN" (Task 12 final review): `constantTimeEquals` (private to this module) had
  // no direct test at all — every existing test only checks the OUTCOME of a hash comparison
  // (match / no match), which a plain `a === b` would also produce correctly. Mutating
  // `constantTimeEquals` to `a === b` is functionally identical for every case those tests
  // exercise and fails none of them; it only reopens a timing side-channel, which a
  // correctness-only assertion can never detect. This spies on `node:crypto`'s
  // `timingSafeEqual` — the actual primitive `constantTimeEquals` must go through — and proves
  // it is genuinely called, which a `===`-based reimplementation would not do.
  it("calls node:crypto's timingSafeEqual when comparing the computed hash against the stored one", async () => {
    timingSafeEqualSpy.mockClear();
    const { key, prefix, hash } = generateApiKey("contoso");
    const p = await authenticateApiKey(key, {
      lookup: async (pf) => pf === prefix
        ? { hash, org_id: "org-1", org_slug: "contoso", user_id: "user-1", revoked_at: null, expires_at: null }
        : null,
      rolesFor: async () => ["field_tech"],
    });
    expect(p).not.toBeNull();
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
    // Called with two Buffers, not the raw strings — constantTimeEquals's own contract.
    const [a, b] = timingSafeEqualSpy.mock.calls[0];
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(Buffer.isBuffer(b)).toBe(true);
  });

  it("still calls timingSafeEqual (and does not short-circuit past it) on a non-matching hash of equal length", async () => {
    timingSafeEqualSpy.mockClear();
    const { key, prefix } = generateApiKey("contoso");
    const wrongButSameLength = hashKey("a-completely-different-key");
    const p = await authenticateApiKey(key, {
      lookup: async (pf) => pf === prefix
        ? { hash: wrongButSameLength, org_id: "o", org_slug: "contoso", user_id: "u", revoked_at: null, expires_at: null }
        : null,
      rolesFor: async () => [],
    });
    expect(p).toBeNull();
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });
});

describe("api keys - S4 (Task 12 final review): last_used_at touch", () => {
  it("calls deps.touch with the resolved prefix on a successful authentication", async () => {
    const { key, prefix, hash } = generateApiKey("contoso");
    const touch = vi.fn(async () => {});
    const p = await authenticateApiKey(key, {
      lookup: async (pf) => pf === prefix
        ? { hash, org_id: "org-1", org_slug: "contoso", user_id: "user-1", revoked_at: null, expires_at: null }
        : null,
      rolesFor: async () => ["field_tech"],
      touch,
    });
    expect(p).not.toBeNull();
    expect(touch).toHaveBeenCalledTimes(1);
    expect(touch).toHaveBeenCalledWith(prefix);
  });

  it("does not call deps.touch for a revoked key", async () => {
    const { key, hash } = generateApiKey("contoso");
    const touch = vi.fn(async () => {});
    await authenticateApiKey(key, {
      lookup: async () => ({ hash, org_id: "o", org_slug: "contoso", user_id: "u", revoked_at: "2026-01-01", expires_at: null }),
      rolesFor: async () => [],
      touch,
    });
    expect(touch).not.toHaveBeenCalled();
  });

  it("does not call deps.touch for a hash mismatch", async () => {
    const { key } = generateApiKey("contoso");
    const touch = vi.fn(async () => {});
    await authenticateApiKey(key, {
      lookup: async () => ({ hash: "wrong", org_id: "o", org_slug: "contoso", user_id: "u", revoked_at: null, expires_at: null }),
      rolesFor: async () => [],
      touch,
    });
    expect(touch).not.toHaveBeenCalled();
  });

  it("does not throw, and still authenticates, when deps.touch itself rejects", async () => {
    const { key, prefix, hash } = generateApiKey("contoso");
    const touch = vi.fn(async () => { throw new Error("db write failed"); });
    const p = await authenticateApiKey(key, {
      lookup: async (pf) => pf === prefix
        ? { hash, org_id: "org-1", org_slug: "contoso", user_id: "user-1", revoked_at: null, expires_at: null }
        : null,
      rolesFor: async () => ["field_tech"],
      touch,
    });
    expect(p).toEqual({ userId: "user-1", orgId: "org-1", orgSlug: "contoso", roles: ["field_tech"], oauthResource: null });
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it("is a no-op (never throws) when deps.touch is not supplied at all", async () => {
    const { key, prefix, hash } = generateApiKey("contoso");
    const p = await authenticateApiKey(key, {
      lookup: async (pf) => pf === prefix
        ? { hash, org_id: "org-1", org_slug: "contoso", user_id: "user-1", revoked_at: null, expires_at: null }
        : null,
      rolesFor: async () => ["field_tech"],
    });
    expect(p).not.toBeNull();
  });
});

describe("api keys - adversarial", () => {
  it("never reaches the database lookup for a malformed key", async () => {
    let lookupCalls = 0;
    const deps = {
      lookup: async () => {
        lookupCalls++;
        return null;
      },
      rolesFor: async () => [],
    };
    const malformed = [
      "not-a-key",
      "",
      "   ",
      "kngw_",
      "kngw_contoso_",
      "kngw_contoso_deadbeef", // missing ".secret" half entirely
      "kngw_contoso_deadbeef.", // empty secret half
      ".secretonly",
      "kngw_../../etc/passwd_deadbeef.secret", // path traversal attempt in org segment
      "kngw_acme$(whoami)_deadbeef.secret", // shell metacharacters
      "kngw_contoso_DEADBEEF.secret", // uppercase hex segment (charset is lowercase only)
      "KNGW_contoso_deadbeef.secret", // wrong-case literal prefix
      "kngw_ACME_deadbeef.AbCdEfGh12", // uppercase ORG segment specifically (not just prefix/hex)
      "kngw_acme.io_deadbeef.AbCdEfGh12", // dot inside the org segment
      "kngw_acme_corp_deadbeef.AbCdEfGh12", // underscore inside the org segment
      "a".repeat(50_000), // very long garbage, must not hang or throw
    ];
    const { key: validKey } = generateApiKey("contoso");
    malformed.push(`${validKey}\n`); // trailing newline must not satisfy a bare `$` anchor
    malformed.push(`${validKey}\nkngw_evil_ff.AAAA`); // smuggled second line after a valid one
    for (const candidate of malformed) {
      expect(parseKey(candidate)).toBeNull();
      expect(await authenticateApiKey(candidate, deps)).toBeNull();
    }
    expect(lookupCalls).toBe(0);
  });

  it("treats hash comparison as case-sensitive, not just non-matching", async () => {
    // Exercises the actual hash-comparison path (constant-length,
    // hex-format value, only its case differs) rather than a key that
    // never gets past parseKey. If comparison were ever done
    // case-insensitively, this would wrongly authenticate.
    const { key, prefix, hash } = generateApiKey("contoso");
    const upperHash = hash.toUpperCase();
    expect(upperHash).not.toBe(hash);
    expect(upperHash.length).toBe(hash.length);
    const deps = {
      lookup: async (pf: string) =>
        pf === prefix
          ? { hash: upperHash, org_id: "org-1", org_slug: "contoso", user_id: "user-1", revoked_at: null, expires_at: null }
          : null,
      rolesFor: async () => ["field_tech"],
    };
    await expect(authenticateApiKey(key, deps)).resolves.toBeNull();
  });

  it("does not confuse a prefix that is a string-prefix of another valid prefix", async () => {
    const short = generateApiKey("contoso"); // prefix e.g. kngw_contoso_ab12cd
    // Fabricate a second, longer prefix that literally starts with the
    // first one's prefix string, to make sure lookup is keyed on the whole
    // captured prefix (exact match) and not a startsWith/substring check.
    const longPrefix = `${short.prefix}ff`;
    const longKey = `${longPrefix}.${short.key.split(".")[1]}`;
    const longHash = hashKey(longKey);

    const rows: Record<string, { hash: string; org_id: string; org_slug: string; user_id: string; revoked_at: string | null; expires_at: string | null }> = {
      [short.prefix]: { hash: short.hash, org_id: "org-short", org_slug: "contoso", user_id: "user-short", revoked_at: null, expires_at: null },
      [longPrefix]: { hash: longHash, org_id: "org-long", org_slug: "contoso", user_id: "user-long", revoked_at: null, expires_at: null },
    };
    const deps = {
      lookup: async (pf: string) => rows[pf] ?? null,
      rolesFor: async () => [],
    };

    const shortPrincipal = await authenticateApiKey(short.key, deps);
    const longPrincipal = await authenticateApiKey(longKey, deps);
    expect(shortPrincipal?.userId).toBe("user-short");
    expect(longPrincipal?.userId).toBe("user-long");
  });

  it("does not throw when the stored hash has a different length than the computed hash", async () => {
    // timingSafeEqual throws on length mismatch; the length check in
    // constantTimeEquals must guard against that so a corrupt/short hash in
    // storage fails auth instead of throwing a 500.
    const { key, prefix } = generateApiKey("contoso");
    const deps = {
      lookup: async (pf: string) =>
        pf === prefix
          ? { hash: "short", org_id: "o", org_slug: "contoso", user_id: "u", revoked_at: null, expires_at: null }
          : null,
      rolesFor: async () => [],
    };
    await expect(authenticateApiKey(key, deps)).resolves.toBeNull();
  });

  it("refuses to mint a principal when the org join fails and org_slug is empty", async () => {
    const { key, prefix, hash } = generateApiKey("contoso");
    const deps = {
      lookup: async (pf: string) =>
        pf === prefix
          ? { hash, org_id: "org-1", org_slug: "", user_id: "user-1", revoked_at: null, expires_at: null }
          : null,
      rolesFor: async () => ["field_tech"],
    };
    expect(await authenticateApiKey(key, deps)).toBeNull();
  });

  it("refuses to mint a principal when org_slug is whitespace-only, not just falsy-empty", async () => {
    const { key, prefix, hash } = generateApiKey("contoso");
    const deps = {
      lookup: async (pf: string) =>
        pf === prefix
          ? { hash, org_id: "org-1", org_slug: " ", user_id: "user-1", revoked_at: null, expires_at: null }
          : null,
      rolesFor: async () => ["field_tech"],
    };
    expect(await authenticateApiKey(key, deps)).toBeNull();
  });

  it("refuses to mint a principal when org_slug is null, undefined, or non-string (RegExp.test coerces to string)", async () => {
    // KeyRow.org_slug is typed `string`, but that's a compile-time promise
    // only -- it crosses an unenforced DB/JSON boundary (a failed join can
    // produce `undefined` from `row.organizations?.slug` with no `?? ""`,
    // or JSON `null` from PostgREST for a missing joined column).
    // RegExp.prototype.test coerces its argument to a string before
    // matching, so a bare `ORG_SLUG_RE.test(row.org_slug)` would stringify
    // `null` to "null" and `undefined` to "undefined" -- both of which
    // match [a-z0-9-]+ and would wrongly authenticate.
    const badValues: unknown[] = [null, undefined, ["acme"]];
    for (const org_slug of badValues) {
      const { key, prefix, hash } = generateApiKey("contoso");
      const deps = {
        lookup: async (pf: string) =>
          pf === prefix
            ? { hash, org_id: "org-1", org_slug: org_slug as unknown as string, user_id: "user-1", revoked_at: null, expires_at: null }
            : null,
        rolesFor: async () => ["field_tech"],
      };
      expect(await authenticateApiKey(key, deps)).toBeNull();
    }
  });

  it("refuses to mint a principal when org_slug contains an embedded newline", async () => {
    // Pins ORG_SLUG_RE's anchors against the same JS-`/m`-flag accident
    // already pinned for KEY_RE: adding `m` here would let "evil\n"
    // authenticate.
    const { key, prefix, hash } = generateApiKey("contoso");
    const deps = {
      lookup: async (pf: string) =>
        pf === prefix
          ? { hash, org_id: "org-1", org_slug: "evil\n", user_id: "user-1", revoked_at: null, expires_at: null }
          : null,
      rolesFor: async () => ["field_tech"],
    };
    expect(await authenticateApiKey(key, deps)).toBeNull();
  });
});

describe("api keys - org slug charset contract", () => {
  const rejectedSlugs = ["acme_corp", "ACME", "acme.io", "acme corp", "açme", "日本", "", "_ab", "ab_"];

  it("throws at generation time for a slug that would not round-trip through parseKey", () => {
    for (const slug of rejectedSlugs) {
      expect(() => generateApiKey(slug)).toThrow();
    }
  });

  it("still round-trips a valid slug", () => {
    const { key, prefix } = generateApiKey("contoso-2");
    expect(parseKey(key)!.prefix).toBe(prefix);
  });
});
