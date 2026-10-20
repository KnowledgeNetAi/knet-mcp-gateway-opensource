import type { Json } from "@/lib/types";

export type Decision =
  | "allowed"
  | "denied_no_grant"
  | "denied_unknown_tool"
  | "denied_bad_args"
  // A valid key for one org used against a different org's path. Distinct from
  // "denied_unknown_tool"/"denied_no_grant" because there is no tool involved yet — this is
  // the MCP handler's org-resolution step, not a tool-call outcome. Added in Task 11 fix
  // round 1 (finding I1): a cross-org attempt is the single most security-relevant denial
  // the gateway can observe, and previously left no audit trace at all.
  | "denied_org_mismatch"
  // A valid OAuth token presented to an org/app resource other than the exact
  // RFC 8707 audience authorized by the user.
  | "denied_resource_mismatch"
  | "error";

export interface AuditRow {
  orgId: string | null;
  userId: string | null;
  principalKind: string;
  app?: string;
  tool?: string;
  decision: Decision;
  args?: Json;
  resultCount?: number;
  upstreamStatus?: number;
  durationMs?: number;
  error?: string;
  /**
   * S3 (Task 12 final review): any role assigned to this principal (a DB `role_assignments`
   * row) that does not exist in the app's committed `roles.json` — `Grant.unknownRoles`
   * (lib/policy/grants.ts), carried through here so a stale/typo'd role assignment leaves a
   * queryable trace instead of only ever manifesting as "this principal mysteriously has no
   * tools," with nothing server-side to diagnose it against.
   */
  unknownRoles?: string[];
}

export type AuditSink = (row: AuditRow) => Promise<void>;

/**
 * How deep `redactValue` will descend into `args` before it gives up on a
 * subtree and replaces it with a marker instead of continuing. Bounded well
 * below any real stack or `JSON.stringify` depth limit: measured against
 * this file's own recursion, an unremarkable-looking ~27KB pure-JSON body
 * nested ~4500 levels deep (no cycles, nothing `JSON.parse` would refuse)
 * blows both this module's own recursion *and* a later `JSON.stringify` of
 * whatever it returns, with a RangeError. A legitimate tool argument --
 * a filter object, nested query params -- never comes close to this depth;
 * only a deliberately or accidentally pathological body does.
 */
const MAX_REDACT_DEPTH = 20;

const REDACTED = "[redacted]";
const CIRCULAR = "[circular]";
const MAX_DEPTH_MARKER = "[max depth exceeded]";
const FUNCTION_MARKER = "[unsupported: function]";
const UNREDACTABLE = "[unredactable]";

/**
 * Redact `args` for storage: any object key literally named in `redact` is
 * replaced with "[redacted]", at any depth (a nested filter object, an
 * array of records, etc. -- `audit.redact` in api.json is a flat list of
 * key names, not a dot-path, so the only way to honor it for a sensitive
 * value nested inside a filter/params object is to walk the whole
 * structure, not just the top level), and matched Unicode-normalized (NFC)
 * on both sides so a canonically-equivalent but differently-encoded key
 * spelling -- which renders identically and so can't be caught by eye the
 * way a case mismatch can -- doesn't silently escape redaction.
 *
 * This safety pass -- depth capping, cycle detection, dropping a literal
 * "__proto__" key, dropping function-typed values -- always runs, even
 * when `redact` is empty (the common case: most tools won't configure
 * `audit.redact` at all). Gating it behind "only if there's something to
 * redact" would leave every hostile-input protection in this file dark for
 * exactly the tools that invoke it most.
 *
 * Always returns a new value; never mutates `args`, at any depth. A
 * handler may still hold and use the same `args` object after logging it
 * (the audit write happens after the tool call, not instead of it), so
 * this function must not be a source of action-at-a-distance on the
 * caller's data.
 *
 * Never throws, and isolates failure to the smallest subtree possible: a
 * single hostile or pathological field (a throwing getter, a cycle, an
 * unreadable Proxy) is replaced with a marker for *that field only* --
 * a sibling field carrying real, legible information (e.g. "customer_search
 * for Acme Plumbing") must survive even when some other field in the same
 * call is poisoned. Collapsing a whole record to one opaque string over a
 * single bad leaf would recreate exactly the "we know someone called it,
 * not what they searched for" failure this file exists to prevent. Only an
 * unreadable root (nothing left to isolate a subtree from) falls back to a
 * single marker for the whole value.
 */
export function redactArgs(args: Json | undefined, redact: string[]): Json | undefined {
  if (args === undefined) return undefined;
  const redactSet = new Set(redact.map((k) => k.normalize("NFC")));
  return redactValue(args, redactSet, new Set<object>(), 0);
}

function redactValue(value: Json, redactSet: Set<string>, ancestors: Set<object>, depth: number): Json {
  if (value === null) return null;
  // Functions aren't valid `Json`, but nothing stops a hostile or merely
  // buggy caller from handing one in anyway -- most dangerously as a
  // `toJSON` method, which `JSON.stringify` calls automatically and which
  // could otherwise resurrect a value this function already redacted (see
  // the "toJSON escape hatch" test). Replacing it with a plain string marker
  // removes the callable entirely, not just its current return value.
  if (typeof value === "function") return FUNCTION_MARKER;
  if (typeof value !== "object") return value;

  if (depth > MAX_REDACT_DEPTH) return MAX_DEPTH_MARKER;

  try {
    // Cycle guard: `Json` disallows this at the type level, but nothing
    // stops a caller from handing us a runtime value that violates it (e.g.
    // an adapter echoing back a response object that turned out to be
    // self-referential). `ancestors` tracks only the current path back to
    // the root, not every object visited, so two sibling fields that
    // legitimately share one reference (a diamond, not a cycle) are each
    // still redacted normally rather than one being flattened to a marker.
    if (ancestors.has(value)) return CIRCULAR;
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return redactArray(value, redactSet, ancestors, depth);
      return Object.fromEntries(redactObject(value as Record<string, unknown>, redactSet, ancestors, depth));
    } finally {
      ancestors.delete(value);
    }
  } catch {
    // A failure reading *this node itself* (e.g. `Object.keys` throwing on
    // a hostile Proxy's `ownKeys` trap) leaves nothing to isolate further:
    // this node -- and only this node -- becomes the marker. A parent one
    // level up still keeps every other sibling, via the per-key/per-element
    // try/catch in redactObject/redactArray below.
    return UNREDACTABLE;
  }
}

function redactArray(value: unknown[], redactSet: Set<string>, ancestors: Set<object>, depth: number): Json[] {
  const out: Json[] = [];
  for (let i = 0; i < value.length; i++) {
    try {
      out.push(redactValue(value[i] as Json, redactSet, ancestors, depth + 1));
    } catch {
      // Isolates one hostile element (e.g. a throwing indexed getter) from
      // the rest of the array instead of losing every element.
      out.push(UNREDACTABLE);
    }
  }
  return out;
}

function redactObject(
  value: Record<string, unknown>,
  redactSet: Set<string>,
  ancestors: Set<object>,
  depth: number,
): [string, Json][] {
  const entries: [string, Json][] = [];
  for (const key of Object.keys(value)) {
    // No legitimate argument or redact-list entry can ever name "__proto__";
    // dropping it here matches lib/policy/filter.ts's `sanitize`, motivated
    // by the same hazard: `Object.fromEntries` itself creates a safe own
    // property for this key, but a downstream consumer that copies the
    // result with `out[key] = v` for a plain object literal would trigger
    // the special __proto__ setter instead, silently rewriting a
    // prototype rather than storing a value.
    if (key === "__proto__") continue;
    try {
      if (redactSet.has(key.normalize("NFC"))) {
        // Matched by key name alone -- the value is never read, so a
        // redacted field's own hostile getter (if it had one) never runs.
        entries.push([key, REDACTED]);
        continue;
      }
      // Read one property at a time (not via `Object.entries(value)`, which
      // evaluates every value up front in one batch): a single throwing
      // getter would otherwise take every other key down with it. Reading
      // per-key, each under its own try/catch, is what makes per-subtree
      // (rather than per-object) failure isolation possible.
      entries.push([key, redactValue(value[key] as Json, redactSet, ancestors, depth + 1)]);
    } catch {
      entries.push([key, UNREDACTABLE]);
    }
  }
  return entries;
}

/**
 * The one error message this module ever logs about a broken sink. Built
 * without ever assuming the shape of `e`: a hostile or merely unusual thrown
 * value (a non-Error, a subclass whose `.message` getter itself throws) must
 * still yield a plain string, because that string is about to be
 * JSON.stringify'd — and a non-string `.message` (an object, especially a
 * circular one) reaching JSON.stringify would throw a *second* time, right
 * inside the handler whose entire job is to survive the first failure.
 *
 * Exported (Task 11 fix round 1, finding I8) so other modules that need the same
 * hostile-thrown-value-to-plain-string sanitization — currently `lib/mcp/handler.ts`, for
 * genericizing a client-facing error message — reuse this one implementation instead of
 * maintaining their own copy, which would only drift from this one over time.
 */
export function safeErrorMessage(e: unknown): string {
  try {
    if (e instanceof Error && typeof e.message === "string") return e.message;
    if (typeof e === "string") return e;
    return "non-Error value thrown";
  } catch {
    return "error message unreadable";
  }
}

/** True if `value` can round-trip through `JSON.stringify` without throwing. */
function isJsonSerializable(value: Json | undefined): boolean {
  if (value === undefined) return true;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Log a broken sink (or a broken row) loudly instead of swallowing it --
 * through `console.error`, itself guarded (some runtimes patch it to
 * throw), and built exclusively from `safeErrorMessage`, never from the
 * caught value itself, so nothing about the failure path can throw a
 * second time.
 */
function logWriteFailure(e: unknown): void {
  try {
    console.error(JSON.stringify({ event: "audit.write_failed", error: safeErrorMessage(e) }));
  } catch {
    // console.error can itself be patched to throw (some runtimes do). This
    // function's entire job is to report a failure without ever being able
    // to cause a second one, so there is nothing further to do but not
    // throw.
  }
}

/** Read one column of `row` in isolation, falling back to `fallback` if reading it throws. */
function readColumn<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * Called only when building the normal, fully-redacted row failed outright
 * (a hostile `redact` entry, or a `row` whose own columns can't even be
 * read/spread safely). Rather than let the row -- a denial, in the
 * worrying case -- vanish with nothing but a console line, this attempts
 * the smallest row that can still answer "who tried what tool, and what
 * happened": every identifying column is read in isolation, under its own
 * guard, so a single poisoned column (e.g. a throwing getter on `orgId`)
 * can't take the others down with it. `args` is never trusted here at all
 * -- it's the very column already implicated in reaching this path -- and
 * is always replaced with a fixed marker instead of being read.
 *
 * This is itself wrapped so that a further failure (the fallback sink call
 * throwing too) still cannot propagate: at this point, logging the failure
 * is the only thing left this function can do.
 */
async function writeMinimalRow(row: AuditRow, sink: AuditSink): Promise<void> {
  const minimal: AuditRow = {
    orgId: readColumn(() => row.orgId, null),
    userId: readColumn(() => row.userId, null),
    principalKind: readColumn(() => row.principalKind, "unknown"),
    app: readColumn(() => row.app, undefined),
    tool: readColumn(() => row.tool, undefined),
    decision: readColumn(() => row.decision, "error"),
    durationMs: readColumn(() => row.durationMs, undefined),
    args: "[unloggable]",
  };
  try {
    await sink(minimal);
  } catch (e) {
    logWriteFailure(e);
  }
}

/**
 * Write one audit row. Exactly one row per call is the contract this
 * function exists to keep -- every caller (allowed, every denial kind,
 * error) writes through here -- and this function guarantees a row reaches
 * `sink`, not merely that it tries to:
 *
 *  - `args` is always redacted here, internally, via `redactArgs`. Redaction
 *    is not something a caller can forget to apply, because there is no
 *    longer a separate step to forget -- and `redact` is a required
 *    parameter, not an optional one defaulting to `[]`, so a call site
 *    cannot silently opt out of even *thinking about* a redact list by
 *    omitting the argument. The caller (the MCP handler) must pass
 *    `tool.audit?.redact ?? []` explicitly.
 *  - the redacted result is then probed for JSON-serializability before
 *    ever reaching `sink`. `redactArgs`'s own depth cap already makes the
 *    overwhelming majority of pathological input safe, but this is a
 *    second, independent backstop for anything that slips past it (a bare
 *    `BigInt` leaf, say). If the row still isn't serializable, `args` is
 *    replaced with a marker while every identifying column -- org, user,
 *    principal, app, tool, decision, duration -- is kept exactly as given.
 *  - if building that row fails outright (redaction itself throwing on a
 *    hostile `redact` entry, or `row`'s own columns being unreadable), the
 *    row is not simply abandoned: `writeMinimalRow` attempts the smallest
 *    row that still identifies who tried what and what happened, built
 *    field by field so one poisoned column can't take the rest with it.
 *    Only if *that* also fails does this function give up -- and even
 *    then, loudly, never silently.
 *
 * A failing sink (a genuine write failure against an otherwise well-formed
 * row) is not retried -- there is nothing more this function can safely
 * infer about a plain database/network failure -- but it must never take
 * down the request that triggered it, so it is logged instead, via
 * `logWriteFailure`.
 */
export async function writeAudit(row: AuditRow, sink: AuditSink, redact: string[]): Promise<void> {
  let safeRow: AuditRow;
  try {
    const redactedArgs = redactArgs(row.args, redact);
    safeRow = isJsonSerializable(redactedArgs)
      ? { ...row, args: redactedArgs }
      : { ...row, args: "[unloggable: not serializable]" };
  } catch (e) {
    // Redaction or reading `row`'s own columns threw outright -- there is
    // no well-formed row to hand `sink`. Do not give up on the row itself:
    // fall back to the smallest row that can still be trusted.
    logWriteFailure(e);
    await writeMinimalRow(row, sink);
    return;
  }

  try {
    await sink(safeRow);
  } catch (e) {
    logWriteFailure(e);
  }
}

export const supabaseAuditSink: AuditSink = async (row) => {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { error } = await createAdminClient().from("audit_events").insert({
    org_id: row.orgId, user_id: row.userId, principal_kind: row.principalKind,
    app: row.app, tool: row.tool, decision: row.decision, args: row.args,
    result_count: row.resultCount, upstream_status: row.upstreamStatus,
    duration_ms: row.durationMs, error: row.error,
    // S3: null rather than an empty array when there's nothing to report — an empty array is
    // a genuinely different, slightly noisier signal ("we checked, there were zero") than "not
    // applicable to this row" (e.g. every decision written before `principal.roles` is even
    // resolved against a catalog, or a request where every assigned role is a real one).
    unknown_roles: row.unknownRoles && row.unknownRoles.length > 0 ? row.unknownRoles : null,
  });
  if (error) throw new Error(error.message);
};
