import { describe, it, expect, vi, beforeEach } from "vitest";
import { redactArgs, writeAudit, supabaseAuditSink, type AuditRow, type AuditSink } from "@/lib/audit/log";
import type { Json } from "@/lib/types";

// `vi.hoisted` is required because `vi.mock` factories are hoisted above
// imports, so the mock can't close over an ordinary module-scope `const`
// declared after it (same pattern as lib/secrets/vault.test.ts).
const { fromMock, insertMock } = vi.hoisted(() => {
  const insertMock = vi.fn(async (_payload: Record<string, unknown>) => ({
    error: null as { message: string } | null,
  }));
  const fromMock = vi.fn((_table: string) => ({ insert: insertMock }));
  return { fromMock, insertMock };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: fromMock }),
}));

const base: AuditRow = {
  orgId: "o1", userId: "u1", principalKind: "api_key",
  app: "servicefusion", tool: "customer_search", decision: "allowed",
  args: { name: "Acme" }, durationMs: 12,
};

describe("redactArgs", () => {
  it("replaces redacted keys with a marker", () => {
    expect(redactArgs({ name: "Acme", ssn: "123" }, ["ssn"]))
      .toEqual({ name: "Acme", ssn: "[redacted]" });
  });
  it("leaves args untouched when nothing is redacted", () => {
    expect(redactArgs({ name: "Acme" }, [])).toEqual({ name: "Acme" });
  });
});

describe("writeAudit", () => {
  it("writes exactly one row", async () => {
    const sink = vi.fn(async () => {});
    await writeAudit(base, sink, []);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("writes a row for a denial too", async () => {
    const sink = vi.fn(async (_row: AuditRow) => {});
    await writeAudit({ ...base, decision: "denied_no_grant" }, sink, []);
    expect(sink.mock.calls[0][0].decision).toBe("denied_no_grant");
  });

  it("never lets a sink failure break the request", async () => {
    const sink = vi.fn(async () => { throw new Error("db down"); });
    await expect(writeAudit(base, sink, [])).resolves.toBeUndefined();
  });
});

// --- Beyond the brief -------------------------------------------------------

describe("redactArgs: completeness", () => {
  it("redacts a sensitive value nested inside an object argument", () => {
    const args: Json = { name: "Acme", filters: { ssn: "123-45-6789", city: "Springfield" } };
    expect(redactArgs(args, ["ssn"])).toEqual({
      name: "Acme",
      filters: { ssn: "[redacted]", city: "Springfield" },
    });
  });

  it("redacts a sensitive value nested inside an array of objects", () => {
    const args: Json = { contacts: [{ fname: "A", ssn: "1" }, { fname: "B", ssn: "2" }] };
    expect(redactArgs(args, ["ssn"])).toEqual({
      contacts: [{ fname: "A", ssn: "[redacted]" }, { fname: "B", ssn: "[redacted]" }],
    });
  });

  it("does not redact a key that differs only in case (exact match only, by design)", () => {
    // audit.redact in api.json names the exact key the config author saw in
    // the tool's input schema; fuzzy/case-insensitive matching would let a
    // misconfigured redact list (wrong case) look like it's working when it
    // silently isn't. Documented here as the current, deliberate behavior.
    const args: Json = { SSN: "123-45-6789" };
    expect(redactArgs(args, ["ssn"])).toEqual({ SSN: "123-45-6789" });
  });

  it("is a no-op when the redact list names a key that does not exist", () => {
    const args: Json = { name: "Acme" };
    expect(redactArgs(args, ["ssn", "does_not_exist"])).toEqual({ name: "Acme" });
  });

  it("does not mutate the caller's args object, including nested objects", () => {
    const filters = { ssn: "123-45-6789", city: "Springfield" };
    const args: Json = { name: "Acme", filters };
    const original = JSON.parse(JSON.stringify(args));

    const out = redactArgs(args, ["ssn"]) as Record<string, Json>;

    // The return value is redacted...
    expect((out.filters as Record<string, Json>).ssn).toBe("[redacted]");
    // ...but the object the caller is still holding (and may still be using,
    // e.g. to build the actual upstream request) is completely untouched,
    // at every depth.
    expect(args).toEqual(original);
    expect(filters.ssn).toBe("123-45-6789");
  });

  it("drops a key literally named __proto__ instead of letting it reach the object setter", () => {
    const malicious = JSON.parse('{"__proto__": {"ssn": "1"}, "name": "Acme"}') as Json;
    const out = redactArgs(malicious, ["ssn"]) as Record<string, Json>;
    expect(out).toEqual({ name: "Acme" });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe("redactArgs: hostile or huge args", () => {
  it("handles a large argument without throwing", () => {
    const big: Json = { name: "Acme", blob: "x".repeat(10_000_000) }; // ~10MB
    expect(() => redactArgs(big, ["ssn"])).not.toThrow();
    const out = redactArgs(big, ["ssn"]) as Record<string, Json>;
    expect((out.blob as string).length).toBe(10_000_000);
  });

  it("fails closed instead of throwing on a circular structure", () => {
    const node: Record<string, unknown> = { name: "Acme" };
    node.self = node; // violates the Json type at runtime, not at compile time
    const out = redactArgs(node as unknown as Json, ["ssn"]) as Record<string, Json>;
    expect(out.name).toBe("Acme");
    expect(out.self).toBe("[circular]");
  });

  it("still redacts siblings that legitimately share one reference (a diamond, not a cycle)", () => {
    const shared = { ssn: "123" };
    const args: Json = { a: shared, b: shared } as unknown as Json;
    expect(redactArgs(args, ["ssn"])).toEqual({ a: { ssn: "[redacted]" }, b: { ssn: "[redacted]" } });
  });

  it("never throws for a hostile getter, and isolates the failure to that one field (not the whole value)", () => {
    // A getter that throws on every access simulates a hostile/adversarial
    // argument object (e.g. a Proxy an adapter forwarded verbatim). This key
    // is NOT in the redact list, so redaction can't short-circuit past the
    // getter by matching on the key name alone (see the redact-list test
    // below for that case) -- the getter is genuinely invoked and throws.
    const hostile = { name: "Acme" } as Record<string, unknown>;
    Object.defineProperty(hostile, "poison", {
      enumerable: true,
      get() { throw new Error("boom"); },
    });
    expect(() => redactArgs(hostile as unknown as Json, ["ssn"])).not.toThrow();
    const out = redactArgs(hostile as unknown as Json, ["ssn"]) as Record<string, Json>;
    expect(out.name).toBe("Acme");
    expect(out.poison).toBe("[unredactable]");
  });

  it("never even reads a redacted key's value, so a redacted field's own hostile getter cannot run", () => {
    const hostile = { name: "Acme" } as Record<string, unknown>;
    Object.defineProperty(hostile, "ssn", {
      enumerable: true,
      get() { throw new Error("boom"); },
    });
    const out = redactArgs(hostile as unknown as Json, ["ssn"]) as Record<string, Json>;
    expect(out).toEqual({ name: "Acme", ssn: "[redacted]" });
  });

  it("fails closed for the whole value only when the root itself is unreadable (nothing left to isolate)", () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys() { throw new Error("boom"); },
      },
    );
    expect(() => redactArgs(proxy as unknown as Json, [])).not.toThrow();
    expect(redactArgs(proxy as unknown as Json, [])).toBe("[unredactable]");
  });
});

describe("writeAudit: sink-failure contract", () => {
  it("logs the failure loudly via console.error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = vi.fn(async () => { throw new Error("db down"); });
    await writeAudit(base, sink, []);
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(spy.mock.calls[0][0] as string) as { event: string; error: string };
    expect(logged.event).toBe("audit.write_failed");
    expect(logged.error).toBe("db down");
    spy.mockRestore();
  });

  it("cannot itself throw when the sink throws a non-Error, non-string value", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = vi.fn(async () => { throw { weird: "object", not: "an Error" }; });
    await expect(writeAudit(base, sink, [])).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("cannot itself throw when the sink throws a circular object (the naive JSON.stringify(e) trap)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const circular: Record<string, unknown> = { message: "cycle" };
    circular.self = circular;
    const sink = vi.fn(async () => { throw circular; });
    // The failure-reporting path must never stringify `e` itself — only a
    // string message ever extracted from it — or a circular thrown value
    // would make console.error's own JSON.stringify throw, defeating the
    // "never break the request" guarantee a second time.
    await expect(writeAudit(base, sink, [])).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("cannot itself throw when the sink throws an Error whose .message getter throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const hostileError = new Error("placeholder");
    Object.defineProperty(hostileError, "message", {
      get() { throw new Error("message getter boom"); },
    });
    const sink = vi.fn(async () => { throw hostileError; });
    await expect(writeAudit(base, sink, [])).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("writeAudit: can a denial go unwritten?", () => {
  it("writes the row even when args is undefined, empty, or huge", async () => {
    const sink = vi.fn(async () => {});
    await writeAudit({ ...base, decision: "denied_bad_args", args: undefined }, sink, []);
    await writeAudit({ ...base, decision: "denied_unknown_tool", args: {} }, sink, []);
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("redactArgs itself never throws even on a genuine cycle (with the safety pass actually engaged), so a caller that redacts before calling writeAudit cannot lose the row before writeAudit is even reached", () => {
    // This is the actual hazard: if a caller does
    //   writeAudit({ ...row, args: redactArgs(row.args, cfg.redact) }, sink)
    // and redactArgs threw synchronously, writeAudit would never be called
    // at all -- not even its own try/catch would run -- and the row (a
    // denial, in the worrying case) would be silently dropped with no log
    // line whatsoever. redactArgs is written to fail closed instead.
    //
    // A non-empty redact list is used deliberately (review finding 3): with
    // an empty list, the old fast path returned the input by reference
    // without ever touching the cycle guard, so the test passed whether or
    // not the guard worked at all. Since fixing finding 2, the safety pass
    // always runs regardless of the redact list, but this test still uses
    // a non-empty one so it keeps proving something even if that changes.
    const node: Record<string, unknown> = { ssn: "123" };
    node.self = node;
    expect(() => redactArgs(node as unknown as Json, ["ssn"])).not.toThrow();
    const out = redactArgs(node as unknown as Json, ["ssn"]) as Record<string, Json>;
    expect(out.ssn).toBe("[redacted]");
    expect(out.self).toBe("[circular]");
  });

  it("writeAudit still produces a row end-to-end when args is nested thousands of levels deep (finding 1)", async () => {
    // Reproduces the reviewer's measured failure: an unremarkable-looking
    // ~27KB pure-JSON body, nested ~4500 levels, with no cycles and nothing
    // JSON.parse would refuse. Before the fix, this blew redactArgs' own
    // recursion (or, with no redact list, skipped redaction and blew up
    // JSON.stringify inside the sink instead) and the row was lost with
    // only a console.error to show for it.
    let deep: Json = { leaf: true };
    for (let i = 0; i < 4500; i++) deep = { nested: deep };

    const written: AuditRow[] = [];
    const dbLikeSink: AuditSink = async (row) => {
      JSON.stringify(row); // what a real sink's HTTP layer does to build a request body
      written.push(row);
    };

    await writeAudit({ ...base, decision: "denied_no_grant", args: deep }, dbLikeSink, []);

    expect(written).toHaveLength(1);
    expect(written[0].orgId).toBe(base.orgId);
    expect(written[0].userId).toBe(base.userId);
    expect(written[0].principalKind).toBe(base.principalKind);
    expect(written[0].decision).toBe("denied_no_grant");
  });
});

describe("redactArgs: depth capping (finding 1a)", () => {
  it("caps recursion depth and degrades gracefully instead of collapsing the whole value", () => {
    let deep: Json = { leaf: true };
    for (let i = 0; i < 4500; i++) deep = { nested: deep };
    const wrapped: Json = { safe: "kept", deep };

    expect(() => redactArgs(wrapped, [])).not.toThrow();
    const out = redactArgs(wrapped, []) as Record<string, Json>;

    // The non-pathological sibling survives...
    expect(out.safe).toBe("kept");
    // ...and the result is bounded enough that a plain JSON.stringify (what
    // a real sink's HTTP layer does) no longer throws.
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(JSON.stringify(out)).toContain("max depth exceeded");
  });
});

describe("redactArgs: Unicode normalization (finding 9)", () => {
  it("redacts a key spelled with a different Unicode normalization than the redact list, when the two render identically", () => {
    const nfcKey = "résumé_ssn"; // "é" as one precomposed codepoint (NFC)
    const nfdKey = "résumé_ssn"; // "e" + combining acute accent, twice (NFD)
    expect(nfcKey).not.toBe(nfdKey); // different code units...
    expect(nfcKey.normalize("NFC")).toBe(nfdKey.normalize("NFC")); // ...but canonically equivalent

    const args: Json = { [nfdKey]: "123-45-6789", other: "kept" };
    const out = redactArgs(args, [nfcKey]) as Record<string, Json>;
    expect(out[nfdKey]).toBe("[redacted]");
    expect(out.other).toBe("kept");
  });
});

describe("redactArgs: accepts AuditRow['args'] directly (finding 10)", () => {
  it("accepts undefined, matching AuditRow.args's Json | undefined type", () => {
    expect(redactArgs(undefined, ["ssn"])).toBeUndefined();
  });
});

describe("redactArgs: hostile-input protections run regardless of the redact list (finding 2)", () => {
  it("still defuses a cycle when redact is empty, instead of returning it by reference with the cycle intact", () => {
    const node: Record<string, unknown> = { name: "Acme" };
    node.self = node;
    const out = redactArgs(node as unknown as Json, []) as Record<string, Json>;
    expect(out).not.toBe(node); // a fresh, safe copy -- not the same cyclic reference
    expect(out.self).toBe("[circular]");
  });
});

describe("redactArgs: toJSON escape hatch (finding 5)", () => {
  it("drops a toJSON method instead of letting it resurrect a redacted secret at serialization time", () => {
    const hostile = { ssn: "SECRET", toJSON() { return { ssn: "SECRET", smuggled: true }; } };
    const out = redactArgs(hostile as unknown as Json, ["ssn"]) as Record<string, Json>;
    expect((out as Record<string, Json>).ssn).toBe("[redacted]");
    // The whole point: a plain JSON.stringify of the *redacted* value must
    // not be able to call back into the original hostile toJSON and recover
    // what was just redacted.
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(JSON.stringify(out)).not.toContain("smuggled");
  });
});

describe("writeAudit: console.error is itself guarded (finding 8)", () => {
  it("still resolves when console.error is patched to throw while reporting a sink failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("logger broken");
    });
    const sink = vi.fn(async () => { throw new Error("db down"); });
    await expect(writeAudit(base, sink, [])).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe("supabaseAuditSink (finding 6)", () => {
  beforeEach(() => {
    fromMock.mockClear();
    insertMock.mockClear();
    insertMock.mockImplementation(async () => ({ error: null }));
  });

  const fullRow: AuditRow = {
    orgId: "o1", userId: "u1", principalKind: "api_key",
    app: "servicefusion", tool: "customer_search", decision: "allowed",
    args: { name: "Acme" }, resultCount: 3, upstreamStatus: 200,
    durationMs: 42, error: undefined,
  };

  it("targets the audit_events table", async () => {
    await supabaseAuditSink(fullRow);
    expect(fromMock).toHaveBeenCalledWith("audit_events");
  });

  it("maps every AuditRow field to its audit_events column", async () => {
    await supabaseAuditSink(fullRow);
    expect(insertMock).toHaveBeenCalledWith({
      org_id: "o1", user_id: "u1", principal_kind: "api_key",
      app: "servicefusion", tool: "customer_search", decision: "allowed",
      args: { name: "Acme" }, result_count: 3, upstream_status: 200,
      duration_ms: 42, error: undefined, unknown_roles: null,
    });
  });

  // --- S3 (Task 12 final review): unknownRoles -> unknown_roles ---

  it("maps a non-empty unknownRoles to the unknown_roles column", async () => {
    await supabaseAuditSink({ ...fullRow, unknownRoles: ["typo_role", "removed_role"] });
    const payload = insertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.unknown_roles).toEqual(["typo_role", "removed_role"]);
  });

  it("maps an absent or empty unknownRoles to null, not an empty array (a distinct, noisier signal)", async () => {
    await supabaseAuditSink(fullRow);
    expect((insertMock.mock.calls[0][0] as Record<string, unknown>).unknown_roles).toBeNull();

    insertMock.mockClear();
    await supabaseAuditSink({ ...fullRow, unknownRoles: [] });
    expect((insertMock.mock.calls[0][0] as Record<string, unknown>).unknown_roles).toBeNull();
  });

  it("never supplies an id -- the column is bigint generated always as identity", async () => {
    await supabaseAuditSink(fullRow);
    const payload = insertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(payload, "id")).toBe(false);
  });

  it("throws when Supabase reports an error, so writeAudit's catch can handle it", async () => {
    insertMock.mockImplementation(async () => ({ error: { message: "duplicate key value" } }));
    await expect(supabaseAuditSink(fullRow)).rejects.toThrow("duplicate key value");
  });

  it("composes with writeAudit: an insert error is caught, not thrown at the caller", async () => {
    insertMock.mockImplementation(async () => ({ error: { message: "db down" } }));
    await expect(writeAudit(fullRow, supabaseAuditSink, [])).resolves.toBeUndefined();
  });

  it("preserves a *defined* error column (finding D)", async () => {
    // `toHaveBeenCalledWith` treats an object with `error: undefined` as
    // equal to one with `error` absent entirely, so the earlier
    // "maps every AuditRow field" test (which used fullRow's
    // `error: undefined`) would still pass even if `error: row.error` were
    // deleted from supabaseAuditSink's insert call outright. A defined
    // value closes that gap.
    const rowWithError: AuditRow = { ...fullRow, decision: "error", error: "upstream 500" };
    await supabaseAuditSink(rowWithError);
    const payload = insertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.error).toBe("upstream 500");
  });
});

describe("writeAudit: everything that touches args stays inside the guarded try, and a row still reaches sink (findings A + E)", () => {
  it("still resolves AND still writes a row (with decision intact) when redact contains a non-string entry", async () => {
    const sink = vi.fn(async (_row: AuditRow) => {});
    const hostileRedact = [123] as unknown as string[];
    await expect(writeAudit(base, sink, hostileRedact)).resolves.toBeUndefined();
    // Resolving alone isn't the guarantee: an empty `async () => {}` body
    // would also resolve without ever calling sink. The row -- specifically
    // its decision, the one column that answers "what happened" -- must
    // actually reach sink.
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0].decision).toBe(base.decision);
  });

  it("still resolves AND still writes a row (with decision intact) when a column on the row itself has a throwing getter", async () => {
    const sink = vi.fn(async (_row: AuditRow) => {});
    const hostileRow = { ...base, decision: "denied_no_grant" } as AuditRow;
    Object.defineProperty(hostileRow, "orgId", {
      enumerable: true,
      get() { throw new Error("boom"); },
    });
    await expect(writeAudit(hostileRow, sink, [])).resolves.toBeUndefined();
    expect(sink).toHaveBeenCalledTimes(1);
    // `orgId` itself is the poisoned column and is allowed to fall back, but
    // `decision` -- read independently -- must survive intact: this is the
    // one column whose loss would make "what did this principal try, and
    // was it allowed" unanswerable.
    expect(sink.mock.calls[0][0].decision).toBe("denied_no_grant");
  });

  it("falls back to a minimal row (not the raw args) when the row can't be built at all", async () => {
    const sink = vi.fn(async (_row: AuditRow) => {});
    const hostileRedact = [123] as unknown as string[];
    await writeAudit({ ...base, decision: "error" }, sink, hostileRedact);
    const written = sink.mock.calls[0][0];
    expect(written.orgId).toBe(base.orgId);
    expect(written.userId).toBe(base.userId);
    expect(written.principalKind).toBe(base.principalKind);
    expect(written.decision).toBe("error");
    // args is the column already implicated in reaching this path; the
    // fallback never trusts it, redacted or not.
    expect(written.args).toBe("[unloggable]");
  });

  it("isolates a poisoned column from the rest of the minimal row: a throwing getter on args doesn't blank out orgId/decision", async () => {
    const sink = vi.fn(async (_row: AuditRow) => {});
    const hostileRow = { ...base, decision: "denied_bad_args" } as AuditRow;
    Object.defineProperty(hostileRow, "args", {
      enumerable: true,
      get() { throw new Error("boom"); },
    });
    await writeAudit(hostileRow, sink, []);
    expect(sink).toHaveBeenCalledTimes(1);
    const written = sink.mock.calls[0][0];
    expect(written.orgId).toBe(base.orgId);
    expect(written.decision).toBe("denied_bad_args");
  });

  // Also fold in (Task 12 final review): the try/catch around `writeMinimalRow`'s own
  // `sink(minimal)` call was recommended for folding in during an earlier round and never
  // covered by a test — mutating it away (letting a throwing fallback sink propagate) fails
  // nothing today.
  it("does not propagate when even the last-resort minimal-row sink call throws", async () => {
    const hostileRedact = [123] as unknown as string[];
    const failingSink = vi.fn(async (_row: AuditRow) => {
      throw new Error("sink is completely down");
    });
    // Reaches writeMinimalRow via the same "redaction throws outright" path the tests above
    // use, but this sink also rejects on the fallback attempt itself -- writeAudit's promise
    // must still resolve, not reject, and the fallback must still have been attempted exactly
    // once.
    await expect(writeAudit({ ...base, decision: "error" }, failingSink, hostileRedact))
      .resolves.toBeUndefined();
    expect(failingSink).toHaveBeenCalledTimes(1);
  });
});

describe("writeAudit: the serializability probe is load-bearing (finding C)", () => {
  it("falls back to the unloggable marker when args is not JSON-serializable even after redaction", async () => {
    const sink = vi.fn(async (_row: AuditRow) => {});
    // A bare BigInt violates the Json type at runtime; it passes through
    // redactArgs unchanged (it's neither an object nor a function), so only
    // the independent JSON.stringify probe in writeAudit catches it.
    const hostileArgs = { amount: BigInt(5) } as unknown as Json;

    await writeAudit({ ...base, args: hostileArgs }, sink, []);

    expect(sink).toHaveBeenCalledTimes(1);
    const written = sink.mock.calls[0][0];
    expect(written.args).toBe("[unloggable: not serializable]");
  });
});

describe("writeAudit: redaction is actually applied to the row sink receives (finding F)", () => {
  it("redacts a top-level and array-nested key before the row reaches sink, while a non-redacted field survives", async () => {
    const sink = vi.fn(async (_row: AuditRow) => {});
    const args: Json = {
      name: "Acme Plumbing",
      ssn: "123-45-6789",
      contacts: [
        { fname: "A", ssn: "111-11-1111" },
        { fname: "B", ssn: "222-22-2222" },
      ],
    };

    await writeAudit({ ...base, args }, sink, ["ssn"]);

    expect(sink).toHaveBeenCalledTimes(1);
    const written = sink.mock.calls[0][0];
    const writtenArgs = written.args as Record<string, Json>;

    expect(writtenArgs.name).toBe("Acme Plumbing");
    expect(writtenArgs.ssn).toBe("[redacted]");
    const contacts = writtenArgs.contacts as Record<string, Json>[];
    expect(contacts[0].ssn).toBe("[redacted]");
    expect(contacts[1].ssn).toBe("[redacted]");
    expect(contacts[0].fname).toBe("A");
    expect(contacts[1].fname).toBe("B");

    // The real point: none of the actual secrets reach the row at all, at
    // any depth -- this is what the whole `writeAudit(row, sink, redact)`
    // ruling (finding 7) exists to guarantee, and it is only meaningful if
    // something asserts it at this layer, not only inside redactArgs.
    const serialized = JSON.stringify(written);
    expect(serialized).not.toContain("123-45-6789");
    expect(serialized).not.toContain("111-11-1111");
    expect(serialized).not.toContain("222-22-2222");
  });
});
