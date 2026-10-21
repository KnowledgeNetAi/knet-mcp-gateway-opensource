import type { AppEntry, Grant, Json, Principal, ToolDef } from "@/lib/types";
import type { AdapterContext } from "@/lib/adapters/types";
import { computeGrant } from "@/lib/policy/grants";
import { filterFields } from "@/lib/policy/filter";
import { writableFieldProblems } from "@/lib/policy/write-policy";
import { UpstreamError } from "@/lib/http/errors";
import {
  rpcError,
  rpcResult,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  PARSE_ERROR,
  INTERNAL_ERROR,
  NOT_FOUND,
  UNAUTHENTICATED,
  type JsonRpcId,
} from "./jsonrpc";
import { redactArgs, safeErrorMessage, type AuditRow } from "@/lib/audit/log";
import { isValidOrgSlug } from "@/lib/policy/slug";
import { resourceMetadataUrl, resourceUrl } from "@/lib/oauth/resource";

const PROTOCOL_VERSION = "2025-06-18";

// The org-mismatch audit row (finding I1) stores the attacker-controlled path segment
// verbatim in `error`. Not injectable (it's a text column, not a header or a query), but
// unbounded all the same — capped so one adversarial path segment can't inflate a row
// arbitrarily (Task 11 fix round 2, finding E).
const MAX_ATTEMPTED_ORG_LEN = 200;

export interface HandlerDeps {
  catalog: Map<string, AppEntry>;
  authenticate(apiKey: string): Promise<Principal | null>;
  runTool(entry: AppEntry, tool: ToolDef, args: Json, ctx: AdapterContext): Promise<Json>;
  /**
   * `redact` is the tool's own `audit.redact` list (`tool.audit?.redact ?? []`), computed by
   * the handler at each call site and threaded through here. It is NOT optional and has no
   * default: `writeAudit(row, sink, redact)` (lib/audit/log.ts) made `redact` a required
   * parameter deliberately, specifically so a call site cannot silently opt out of even
   * *thinking about* a redact list by omitting the argument. This is a correction over the
   * original task brief, which specified `audit(row: AuditRow): Promise<void>` with no way to
   * carry a per-tool redact list through to `writeAudit` at all — see the Task 11 report,
   * "interface drift" section.
   */
  audit(row: AuditRow, redact: string[]): Promise<void>;
  /**
   * Builds the per-app adapter context (`http`, `secret`, `config`, `log`). Injected rather
   * than constructed inline in the handler (Task 11 fix round 1, finding I6): a hard-coded
   * `buildContext` made it impossible for a test to assert what `ctx` the handler actually
   * passes to `runTool`, forced every handler test to transitively load the real Vault module,
   * and — because the call happened outside the `try` around `runTool` — meant a failure here
   * (e.g. a malformed transport config) produced an uncaught exception and zero audit rows
   * instead of a normal `decision: "error"` row. `route-deps.ts` supplies the real
   * implementation; tests supply a fake one.
   */
  buildContext(entry: AppEntry): Promise<AdapterContext>;
}

export interface McpInput {
  orgSlug: string;
  appSlug: string | null;
  body: unknown;
  apiKey: string | null;
  deps: HandlerDeps;
  /**
   * Bare-origin issuer for this request (`scheme://host`), used to build the
   * `resource_metadata` URL on an unauthenticated 401 (RFC 9728 §5.1). Callers
   * derive this with `issuerFromRequest` (or an equivalent header read) rather
   * than the handler reaching into request internals itself.
   */
  issuer: string;
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Exposed name is "<app>_<tool>"; config declares the bare tool name. Case-sensitive,
 *  exact-match only — a tool name differing only in case (or containing extra characters)
 *  is a different string and therefore reported as "unknown tool", never matched loosely. */
const exposedName = (app: string, tool: string) => `${app}_${tool}`;

/**
 * Advertise a tool's effect using the standard MCP ToolAnnotations hints.
 *
 * `write` is the source of truth rather than the HTTP verb: POST is also used
 * by read-only search tools. A configured request always reaches an upstream
 * SaaS API, hence `openWorldHint`; a tool with no request has no effect we can
 * infer safely and deliberately receives no annotations, leaving it in the
 * client's "Other" group.
 */
function toolAnnotations(tool: ToolDef) {
  if (!tool.request) return undefined;

  if (!tool.write) {
    return {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    };
  }

  return {
    readOnlyHint: false,
    // POST writes are creates; PATCH writes may replace existing field values.
    destructiveHint: tool.request.method === "PATCH",
    // Keep mutation retry semantics conservative even when repeating a PATCH
    // with identical inputs happens to produce the same final field values.
    idempotentHint: false,
    openWorldHint: true,
  };
}

/**
 * A stable, non-identifying failure class for the client (Task 11 fix round 2, finding D).
 * C2 genericized the client-facing error message to close a data leak, but that also erased
 * the one distinction a caller (or the LLM relaying its result) legitimately needs — "the
 * upstream rejected this request" (e.g. no such customer) vs. "the upstream is broken" vs.
 * "the gateway itself failed" — collapsing all three into an identical, useless
 * "tool call failed". This restores that distinction without reopening C2: no status code, no
 * URL, no upstream body ever appears here, only one of these three fixed strings.
 */
function failureClass(e: unknown): string {
  if (e instanceof UpstreamError) {
    if (e.status >= 400 && e.status < 500) return `upstream_4xx (${clientErrorKind(e.status)})`;
    if (e.status >= 500 && e.status < 600) return "upstream_5xx (the upstream service failed; retrying later may work)";
    // Status 0 is the HTTP client's own marker for "no response": a timeout, a spent
    // deadline, or a connection failure. Before this, it was indistinguishable from a gateway
    // bug, so a slow upstream query read to the caller as a broken connector.
    if (e.status === 0) return "upstream_unreachable (no response before the timeout; narrow the query or retry)";
  }
  return "gateway_error";
}

/**
 * Fixed, digit-free wording per 4xx kind. A caller acting on "upstream_4xx" alone cannot tell
 * "you lack permission to this whole resource" from "that argument was wrong", and an LLM
 * relaying the result will guess — one wrote a customer report blaming a permissions gap for
 * what was a bad sort parameter. Every string here is a constant chosen by the gateway; none
 * carries upstream text, so finding C2's guarantee holds.
 */
function clientErrorKind(status: number): string {
  switch (status) {
    case 400:
    case 422:
      return "rejected: an argument or filter value was not accepted";
    case 401:
      return "unauthorized: the gateway's upstream credential was not accepted";
    case 403:
      return "forbidden: the connected upstream account has no access to this resource";
    case 404:
      return "not found: no record with that id";
    case 429:
      return "rate limited: retry later";
    default:
      return "rejected by the upstream";
  }
}

/** Logs a failure server-side only. Never reaches the client response or an audit row —
 *  both of those must stay generic for an infrastructure failure (see `HandlerDeps.authenticate`
 *  usage below), but server logs are the one place the real detail is useful for on-call. */
function principalKindOf(principal: Principal): "api_key" | "oauth" {
  return principal.oauthResource !== null ? "oauth" : "api_key";
}

const MAX_ERROR_DETAIL_LEN = 2000;

/** Every scalar `redactArgs` replaced, so the same values can be scrubbed elsewhere. */
function redactedValues(
  original: Json | undefined,
  redacted: Json | undefined,
  out: string[] = [],
  depth = 0,
): string[] {
  if (original === null || original === undefined || depth > 32) return out;
  if (typeof original !== "object") {
    if (redacted !== original && String(original).length > 0) out.push(String(original));
    return out;
  }
  if (redacted === null || typeof redacted !== "object") {
    // A whole subtree was replaced: every scalar under it counts.
    return redactedValues(original, undefined as unknown as Json, out, depth + 1);
  }
  for (const [k, v] of Object.entries(original)) {
    redactedValues(v, (redacted as Record<string, Json>)[k], out, depth + 1);
  }
  return out;
}

/**
 * An upstream error message names the full request URL and a slice of the
 * response body. Before it is stored in the audit row or logged, drop query
 * strings (built from caller arguments) and every value `audit.redact`
 * covers, wherever it was interpolated, and cap the length.
 */
export function scrubErrorDetail(detail: string, args: Json, redact: string[]): string {
  let out = detail.replace(/\?[^\s]*/g, "?[query omitted]");
  if (redact.length > 0) {
    try {
      for (const raw of new Set(redactedValues(args, redactArgs(args, redact)))) {
        for (const form of new Set([raw, encodeURIComponent(raw)])) out = out.split(form).join("[redacted]");
      }
    } catch {
      // Never let scrubbing cost the audit row; keep only what cannot carry an argument.
      out = "upstream request failed (detail withheld)";
    }
  }
  return out.slice(0, MAX_ERROR_DETAIL_LEN);
}

function logFailure(event: string, e: unknown): void {
  try {
    console.error(JSON.stringify({ event, error: safeErrorMessage(e) }));
  } catch {
    // Never let a logging failure propagate.
  }
}

/**
 * Write one audit row without ever letting a failure in `deps.audit` itself propagate out of
 * `handleMcpRequest` (Task 11 fix round 1, finding I7). `writeAudit`'s real implementation
 * (lib/audit/log.ts) already swallows a failing *sink*, but this handler's own "the request
 * is never taken down by an audit-layer problem" guarantee must not rest on a promise the
 * injected `deps.audit` happens to keep today — a test double, or a future reimplementation,
 * could reject directly. A rejection here is logged, never rethrown.
 */
async function safeAudit(deps: HandlerDeps, row: AuditRow, redact: string[]): Promise<void> {
  try {
    await deps.audit(row, redact);
  } catch (e) {
    logFailure("mcp.audit_failed", e);
  }
}

/**
 * Validate `args` against a tool's declared `input` JSON-schema-shaped object (config schema
 * leaves `input` as a free-form record — lib/config/schema.ts's `toolSchema.input` is
 * `z.record(z.string(), z.unknown())` — so this reads `properties`/`required` defensively,
 * never assuming either is present or well-shaped).
 *
 * Reject-unknown-arguments is spec, not an enhancement: the phase 1 design, request
 * lifecycle step 7, "Validate arguments
 * against the declared schema. Reject unknown params rather than forwarding them — an
 * unrecognized Service Fusion filter silently returns the entire collection." The task-11
 * brief's reference `handler.ts` never implemented this step at all — passing `args`
 * straight through to `runTool` — which is exactly the kind of silent-forward bug this
 * function exists to prevent. A tool with no `properties` declared (e.g. `{ "type": "object" }`
 * alone) is treated as accepting no arguments: every key on such a tool is "unknown" by
 * construction, which matches every existing fixture (they only ever call such tools with
 * `arguments: {}`).
 *
 * SUPPORTED SUBSET (documented here per Task 11 fix round 1, finding I4 — `checkToolInputSchema`
 * below enforces this same subset at catalog-load time, so a config using anything outside it
 * fails the build instead of failing a customer's live request): a plain JSON-Schema object with
 * `type: "object"`, an optional flat `properties` map (used only for its key set — nested
 * shapes/types are not validated), and an optional `required` array whose every name is a key
 * of `properties`. No `$ref`, `oneOf`, `allOf`, `anyOf`, or `patternProperties` at the top
 * level, and no `additionalProperties: true` (this validator always denies an unrecognized key,
 * so a schema that declares permissive `additionalProperties` cannot be honored).
 *
 * A required argument whose value is `null` or absent is rejected identically (Task 11 fix
 * round 1, finding I3): treating a null value as satisfying `required` would let
 * `lib/adapters/run.ts`'s query-interpolation silently drop that null/undefined arg from the
 * URL — turning a *recognized* required filter into an unfiltered full-collection scan, the
 * exact failure mode step 7 exists to prevent, just reached through a different gap.
 *
 * The presence check itself is `Object.hasOwn`, never a plain `args[name]` read (Task 11 fix
 * round 2, finding B): a bare property read resolves through the prototype chain, so a
 * `required` name that happens to collide with an inherited `Object.prototype` member
 * (`toString`, `constructor`, `valueOf`, `hasOwnProperty`, …) would read as "present" —
 * `Object.prototype.toString` itself — even when `args` has no such *own* key at all,
 * reopening exactly the null-required bug above through a different name. Same class of
 * defect as the `Object.keys`-vs-prototype-chain issue already fixed in the adapter task.
 *
 * `Object.hasOwn` alone is necessary but not sufficient, though (Task 11 fix round 3, finding
 * G): it treats an own key explicitly set to `undefined` as "present", which is exactly as
 * unfiltered-full-collection-scan-shaped as a `null` value once it reaches
 * `lib/adapters/run.ts`'s query interpolation (both are dropped from the URL the same way).
 * Unreachable over the wire — `req.json()` can never produce a value of `undefined`, since
 * JSON has no such literal — but this function makes no assumption about how it's called, and
 * an in-process caller can construct one directly. Both `null` and an own `undefined` are
 * rejected identically.
 */
/**
 * Checks one present, non-null/undefined argument value against its property schema's `type`
 * and `minLength` — the two JSON-Schema keywords `checkToolInputSchema` guarantees are sane by
 * the time a live request reaches this function (see that function's own validation of them).
 * Returns a problem string, or `null` if the value satisfies both (or neither keyword is
 * declared, in which case there's nothing to check).
 *
 * "ALSO FOLD IN" (Task 12 final review): before this, `validateArgs` checked key names and
 * `required` presence only — never the declared `type` — so `name=0`, `name=[]`, `name={}`,
 * `name=true` all reached the upstream filter for a tool declaring `"name": {"type":
 * "string"}`, and the gateway advertised a type to the calling model while enforcing none of
 * it. `minLength` closes the empty-string half of the same gap for `customer_search.name`
 * specifically (see the schema-load test and `orgs/contoso/servicefusion/api.json`):
 * `name=""` is a well-typed string, so `type` checking alone would still let it through, and
 * `lib/adapters/run.ts`'s `interpolateQuery` treats a present empty string as a normal,
 * resolved value (not a missing one) — an empty `filters[customer_name]` value is not "no
 * filter", it is Service Fusion's literal filter-by-empty-string, which this vendor's API may
 * or may not treat the same as "no filter" and which the gateway has no business forwarding
 * either way. Rejecting it here, before the call is ever dispatched, is deliberately NOT the
 * same fix as making `interpolateQuery` treat `""` as unresolved (and therefore omitted) —
 * that would silently turn a caller's `name=""` into a full, unfiltered collection scan instead
 * of an error, which is worse than either outcome this function chooses between.
 */
function typeAndLengthProblem(value: Json, propSchema: Record<string, unknown>, key: string): string | null {
  const type = propSchema.type;
  if (typeof type === "string") {
    const matchesType = (() => {
      switch (type) {
        case "string": return typeof value === "string";
        case "number": return typeof value === "number" && Number.isFinite(value);
        case "integer": return typeof value === "number" && Number.isInteger(value);
        case "boolean": return typeof value === "boolean";
        case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
        case "array": return Array.isArray(value);
        // An unrecognized declared type isn't this validator's job to enforce —
        // `checkToolInputSchema` doesn't restrict `type` to a known set, so a config could
        // legitimately declare something this validator doesn't understand yet.
        default: return true;
      }
    })();
    if (!matchesType) return `argument "${key}" must be of type ${type}`;
  }

  const minLength = propSchema.minLength;
  if (typeof minLength === "number") {
    // Only string/array values have a meaningful `.length` to enforce a minimum on; a
    // `minLength` declared alongside a non-string/array `type` (or no `type` at all, paired
    // with a value that isn't one) has nothing to check here.
    if (typeof value === "string" && value.length < minLength) {
      return `argument "${key}" must have length >= ${minLength}`;
    }
    if (Array.isArray(value) && value.length < minLength) {
      return `argument "${key}" must have length >= ${minLength}`;
    }
  }

  return null;
}

function validateArgs(input: Record<string, unknown>, rawArgs: Json): string[] {
  if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return ["arguments must be an object"];
  }
  const args = rawArgs as Record<string, Json>;

  const properties =
    input.properties && typeof input.properties === "object" && !Array.isArray(input.properties)
      ? (input.properties as Record<string, unknown>)
      : {};
  const known = new Set(Object.keys(properties));

  const problems: string[] = [];
  for (const key of Object.keys(args)) {
    if (!known.has(key)) {
      problems.push(`unknown argument: ${key}`);
      continue;
    }
    const value = args[key];
    // A null/undefined value here is either rejected by the `required` check below (if this
    // key is required) or is a legitimately absent optional argument — type/minLength checking
    // an absent value is meaningless either way.
    if (value === null || value === undefined) continue;
    const propSchema = properties[key];
    if (propSchema && typeof propSchema === "object" && !Array.isArray(propSchema)) {
      const problem = typeAndLengthProblem(value, propSchema as Record<string, unknown>, key);
      if (problem) problems.push(problem);
    }
  }

  const required = Array.isArray(input.required) ? input.required : [];
  for (const name of required) {
    if (typeof name !== "string") continue;
    if (!Object.hasOwn(args, name) || args[name] === null || args[name] === undefined) {
      problems.push(`missing required argument: ${name}`);
    }
  }
  return problems;
}

/**
 * Boot-time (catalog-load-time) check that a tool's `input` is a shape `validateArgs` actually
 * understands. Added in Task 11 fix round 1, finding I4: `lib/config/schema.ts` leaves `input`
 * as an unvalidated free-form record, so nothing before this caught a config using a JSON-Schema
 * feature `validateArgs` silently ignores (`$ref`, `oneOf`, …) or, worse, a `required` name absent
 * from `properties` — which makes a tool permanently uncallable (every call rejected as missing
 * that argument, and the argument itself always rejected as unknown, since it was never added to
 * `properties`) with no signal until a live request fails. See `validateArgs`'s doc comment for
 * the exact supported subset this enforces. Returns a problem string, or `null` if the schema is
 * fine; never throws.
 */
export function checkToolInputSchema(tool: ToolDef): string | null {
  const input = tool.input;
  const UNSUPPORTED_TOP_LEVEL_KEYS = ["$ref", "oneOf", "allOf", "anyOf", "patternProperties"] as const;
  for (const key of UNSUPPORTED_TOP_LEVEL_KEYS) {
    if (key in input) {
      return `tool "${tool.name}": input uses unsupported top-level "${key}" — only a plain object schema with "properties"/"required" is supported`;
    }
  }
  if (input.additionalProperties === true) {
    return `tool "${tool.name}": input declares additionalProperties: true, but the gateway always rejects an unrecognized argument — this schema cannot be honored`;
  }

  const properties = input.properties;
  if (properties !== undefined && (typeof properties !== "object" || properties === null || Array.isArray(properties))) {
    return `tool "${tool.name}": input.properties must be an object`;
  }
  const propsRecord = (properties as Record<string, unknown> | undefined) ?? {};
  const knownProps = new Set(Object.keys(propsRecord));

  // "ALSO FOLD IN" (Task 12 final review): `validateArgs` now honors a property's declared
  // `type`/`minLength` at request time (`typeAndLengthProblem`) — checked here too, at boot,
  // for the same reason every other shape in this function is: a config declaring a `type`
  // this validator can't act on sensibly, or a `minLength` that isn't a meaningful bound,
  // should fail the build, not silently no-op on every live request forever.
  const KNOWN_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array"]);
  for (const [propName, propSchema] of Object.entries(propsRecord)) {
    if (!propSchema || typeof propSchema !== "object" || Array.isArray(propSchema)) continue;
    const { type, minLength } = propSchema as Record<string, unknown>;
    if (type !== undefined) {
      if (typeof type !== "string" || !KNOWN_TYPES.has(type)) {
        return `tool "${tool.name}": input.properties.${propName}.type ${JSON.stringify(type)} is not one of ${[...KNOWN_TYPES].join(", ")}`;
      }
    }
    if (minLength !== undefined) {
      if (typeof minLength !== "number" || !Number.isInteger(minLength) || minLength < 0) {
        return `tool "${tool.name}": input.properties.${propName}.minLength must be a non-negative integer`;
      }
      if (type !== undefined && type !== "string" && type !== "array") {
        return `tool "${tool.name}": input.properties.${propName} declares minLength but type is ${JSON.stringify(type)}, not "string" or "array"`;
      }
    }
  }

  const required = input.required;
  if (required !== undefined) {
    if (!Array.isArray(required)) return `tool "${tool.name}": input.required must be an array`;
    for (const name of required) {
      if (typeof name !== "string" || !knownProps.has(name)) {
        return `tool "${tool.name}": input.required names ${JSON.stringify(name)}, which is not a key of input.properties`;
      }
    }
  }
  return null;
}

/**
 * The RFC 9728 §5.1 challenge. `orgSlug` reaches this function BEFORE
 * authentication has run and is a caller-controlled path segment, so a slug
 * outside the charset gets a bare `Bearer` — it cannot name a real org anyway,
 * and emitting it would splice untrusted text into a response header.
 */
function challengeHeader(orgSlug: string, appSlug: string | null, issuer: string): string {
  if (!isValidOrgSlug(orgSlug)) return "Bearer";
  if (appSlug !== null && !isValidOrgSlug(appSlug)) return "Bearer";
  return `Bearer resource_metadata="${resourceMetadataUrl(issuer, orgSlug, appSlug)}"`;
}

export async function handleMcpRequest(input: McpInput): Promise<Response> {
  const { orgSlug, appSlug, body, apiKey, deps, issuer } = input;

  // The id is read defensively before anything else so that even a malformed body (a
  // primitive, an array, null) still gets a well-formed JSON-RPC error echoing back an id
  // where one can be determined — never a thrown exception. Property access on a non-null,
  // non-undefined value never throws in JS (it just yields `undefined` for a primitive), so
  // only the `null`/`undefined` cases need the `?.` guard.
  const idCandidate =
    body !== null && typeof body === "object" ? (body as { id?: JsonRpcId }).id : undefined;
  const id: JsonRpcId = idCandidate ?? null;

  if (!apiKey) {
    return new Response(JSON.stringify(rpcError(id, UNAUTHENTICATED, "authentication required")), {
      status: 401,
      headers: {
        "content-type": "application/json",
        // Phase 2: the resource_metadata parameter finding S6 deferred is
        // restored, now that app/.well-known/oauth-protected-resource/mcp/[org]
        // actually serves the document it points at — S6's failure mode was an
        // RFC 9728 client fetching an advertised URL and getting a Next.js 404
        // HTML page, which reads as a broken gateway.
        //
        // S6's other warning — never interpolate a caller-controlled path
        // segment raw into a response header — is honored by validating the
        // slug SYNTACTICALLY, against the same charset lib/policy/slug.ts owns.
        // A slug that fails gets a bare challenge. Validation is deliberately
        // not a catalog lookup: known and unknown orgs must stay
        // indistinguishable, or this header becomes an enumeration oracle.
        "WWW-Authenticate": challengeHeader(orgSlug, appSlug, issuer),
      },
    });
  }

  let principal: Principal | null;
  try {
    principal = await deps.authenticate(apiKey);
  } catch (e) {
    // `authenticateApiKey` rejects (rather than resolving `null`) on an infrastructure
    // failure (e.g. Supabase unreachable) — see lib/auth/api-key.ts's doc comment. Reporting
    // that as a 401 would tell a legitimate caller their key is bad, and forwarding `e` to the
    // client or into the audit row (which an org admin can read, per the design doc) risks
    // leaking infrastructure detail such as a connection string. Log the real error
    // server-side only; the client and the audit row both get a generic message.
    logFailure("mcp.authenticate_failed", e);
    await safeAudit(
      deps,
      {
        orgId: null,
        userId: null,
        principalKind: "api_key",
        decision: "error",
        error: "authentication failed",
      },
      [],
    );
    return json(rpcError(id, INTERNAL_ERROR, "internal error"), 500);
  }

  // An unrecognized/invalid key resolves to `null` here — there is no principal, so no
  // org/user to attribute an audit row to (same reasoning as skipping bare 401s: unbounded,
  // and unattributable). This is intentionally the *only* branch that returns 404 with no
  // audit row; a *resolved* principal whose org doesn't match the path is handled just below
  // and IS audited.
  if (!principal) {
    return json(rpcError(id, NOT_FOUND, "not found"), 404);
  }

  // A wrong-org request must not confirm the org exists (spec, lifecycle step 2): a resolved
  // principal for the wrong org gets the exact same 404 an invalid key gets above — same
  // status, same body shape — so a caller cannot distinguish "your key doesn't exist," "your
  // key is fine but this isn't your org," and "this org doesn't exist" from one another.
  //
  // Task 11 fix round 1, finding I1: unlike the branch above, a row IS written here — a valid
  // key for org A pointed at org B's path is the single most security-relevant denial this
  // gateway can observe, and (unlike the `!principal` branch) there is a real principal to
  // attribute it to. The attempted org goes in `error`, never in a column (e.g. `app`) that
  // could read as if the request had succeeded against it.
  if (principal.orgSlug !== orgSlug) {
    await safeAudit(
      deps,
      {
        orgId: principal.orgId,
        userId: principal.userId,
        principalKind: "api_key",
        decision: "denied_org_mismatch",
        error: `attempted org: ${orgSlug.slice(0, MAX_ATTEMPTED_ORG_LEN)}`,
      },
      [],
    );
    return json(rpcError(id, NOT_FOUND, "not found"), 404);
  }

  // Manual keys are intentionally org-wide (`oauthResource === null`). An
  // OAuth token is narrower: it may be used only at the exact RFC 8707
  // resource authorized by the user. In particular, a token minted for
  // `/mcp/<org>/<app-a>` must not be replayable at a sibling app or at the
  // aggregate `/mcp/<org>` endpoint.
  const requestedResource = resourceUrl(issuer, orgSlug, appSlug);
  if (principal.oauthResource !== null && principal.oauthResource !== requestedResource) {
    await safeAudit(
      deps,
      {
        orgId: principal.orgId,
        userId: principal.userId,
        principalKind: "oauth",
        decision: "denied_resource_mismatch",
        error: "OAuth resource does not match request",
      },
      [],
    );
    return json(rpcError(id, NOT_FOUND, "not found"), 404);
  }

  const entries = [...deps.catalog.values()].filter(
    (e) => e.org === orgSlug && (appSlug === null || e.app === appSlug),
  );
  if (entries.length === 0) return json(rpcError(id, NOT_FOUND, "not found"), 404);

  const grants = new Map<string, { entry: AppEntry; grant: Grant }>();
  for (const entry of entries) {
    grants.set(entry.app, {
      entry,
      grant: computeGrant(principal.roles, entry.roles, entry.config.tools),
    });
  }

  // S3 (Task 12 final review): `computeGrant` already computes `Grant.unknownRoles` — every
  // role assigned to this principal (in `role_assignments`, a DB row an admin controls) that
  // doesn't exist in this app's committed `roles.json` — but until now nothing consumed it.
  // A stale role assignment (the role was renamed or removed in a later config edit, or a typo
  // was written into the DB row directly) fails closed exactly as the spec requires: the
  // principal simply gets no tools. But it fails SILENTLY closed — the likeliest resulting
  // support ticket ("I connected and Claude sees no tools") leaves zero server-side trace to
  // diagnose against. Logged here once per request, and threaded into every audit row this
  // request writes below, so both a live log line and a queryable audit trail exist.
  const unknownRoles = [...new Set([...grants.values()].flatMap(({ grant }) => grant.unknownRoles))];
  if (unknownRoles.length > 0) {
    try {
      console.warn(
        JSON.stringify({
          event: "mcp.unknown_roles",
          orgId: principal.orgId,
          userId: principal.userId,
          roles: unknownRoles,
        }),
      );
    } catch {
      // Never let a logging failure take down the request.
    }
  }

  // Everything past this point needs a well-formed JSON-RPC request object: not null, not a
  // primitive, and — per JSON-RPC 2.0 — not a batch array either (this gateway is a single
  // synchronous HTTP handler per call; batching is out of scope, and silently processing only
  // the first element of a batch would be worse than rejecting it outright).
  if (body === null || typeof body !== "object") {
    return json(rpcError(id, PARSE_ERROR, "invalid request"), 400);
  }
  if (Array.isArray(body)) {
    return json(rpcError(id, INVALID_PARAMS, "batch requests are not supported"), 400);
  }
  const rpc = body as { method?: string; params?: unknown };

  switch (rpc.method) {
    case "initialize":
      return json(
        rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: `mcp-gateway/${orgSlug}`, version: "1.0.0" },
        }),
      );

    case "tools/list": {
      const tools = [];
      for (const { entry, grant } of grants.values()) {
        for (const tool of entry.config.tools) {
          if (!grant.tools.has(tool.name)) continue;
          const annotations = toolAnnotations(tool);
          tools.push({
            name: exposedName(entry.app, tool.name),
            description: tool.description,
            inputSchema: tool.input,
            ...(annotations ? { annotations } : {}),
          });
        }
      }
      return json(rpcResult(id, { tools }));
    }

    case "tools/call": {
      const started = Date.now();
      const params = rpc.params && typeof rpc.params === "object" ? (rpc.params as Record<string, unknown>) : {};
      const requested = String((params as { name?: unknown }).name ?? "");
      const rawArgs = ((params as { arguments?: unknown }).arguments ?? {}) as Json;

      // `tools/call` re-checks the grant independently of whatever `tools/list` returned:
      // the caller controls the request body and must never be trusted to have only asked
      // for a tool this same handler previously listed for it (spec, lifecycle step 6).
      let found: { entry: AppEntry; grant: Grant; tool: ToolDef } | null = null;
      for (const { entry, grant } of grants.values()) {
        const tool = entry.config.tools.find((t) => exposedName(entry.app, t.name) === requested);
        if (tool) {
          found = { entry, grant, tool };
          break;
        }
      }

      // Ungranted and nonexistent are reported identically ("unknown tool"), never as
      // "forbidden"/"denied": that distinction is exactly what would let a caller enumerate
      // the catalog by which error they get back. The audit row records the true reason.
      if (!found || !found.grant.tools.has(found.tool.name)) {
        // Task 11 fix round 1, finding I2: when the tool name doesn't resolve at all
        // (`found` is null), there is no specific tool to read an `audit.redact` list from —
        // but the caller-supplied `args` still get logged verbatim otherwise. An LLM client
        // that typos a tool name while passing real, sensitive arguments (an SSN meant for a
        // tool that *does* configure `audit.redact`) must not have that argument reach the
        // audit table in the clear just because the name didn't match. Falling back to the
        // union of every redact list configured anywhere in this org's (catalog-scoped)
        // tools is the safe set: we don't know which tool was meant, so redact everything any
        // of them would have.
        const redact = found
          ? (found.tool.audit?.redact ?? [])
          : [...new Set(entries.flatMap((e) => e.config.tools.flatMap((t) => t.audit?.redact ?? [])))];
        await safeAudit(
          deps,
          {
            orgId: principal.orgId,
            userId: principal.userId,
            principalKind: principalKindOf(principal),
            app: found?.entry.app,
            // S2 (Task 12 final review): `tool` is always the bare, config-declared name once
            // a tool actually resolved — matching every other decision below (`denied_bad_args`,
            // `allowed`, `error`), all of which write `tool.name`, never the app-prefixed
            // exposed name (`${app}_${name}`). Writing the exposed name here instead, as this
            // did before the fix, meant `where tool = 'customer_search'` silently missed every
            // `denied_no_grant` row for that tool — the one query an org admin would actually
            // run to answer "who has tried to use this tool and been refused." The raw,
            // caller-supplied `requested` string is kept only for `denied_unknown_tool`, where
            // nothing resolved and there is no config name to normalize to.
            tool: found ? found.tool.name : requested.slice(0, MAX_ATTEMPTED_ORG_LEN),
            decision: found ? "denied_no_grant" : "denied_unknown_tool",
            args: rawArgs,
            durationMs: Date.now() - started,
            ...(unknownRoles.length > 0 ? { unknownRoles } : {}),
          },
          redact,
        );
        return json(rpcError(id, INVALID_PARAMS, `unknown tool: ${requested}`));
      }

      const { entry, grant, tool } = found;
      const redact = tool.audit?.redact ?? [];

      // Spec, lifecycle step 7: reject unknown arguments rather than forwarding them. This
      // must run before the tool is ever dispatched — an unrecognized Service Fusion filter
      // forwarded as-is silently returns the whole collection instead of erroring.
      const problems = validateArgs(tool.input, rawArgs);
      if (problems.length > 0) {
        await safeAudit(
          deps,
          {
            orgId: principal.orgId,
            userId: principal.userId,
            principalKind: principalKindOf(principal),
            app: entry.app,
            tool: tool.name,
            decision: "denied_bad_args",
            args: rawArgs,
            error: problems.join("; "),
            durationMs: Date.now() - started,
            ...(unknownRoles.length > 0 ? { unknownRoles } : {}),
          },
          redact,
        );
        return json(rpcError(id, INVALID_PARAMS, problems[0]));
      }

      // Write policy, for a tool that declares a `write` block. This runs
      // AFTER validateArgs (so the argument is known to exist and to be
      // declared) and BEFORE dispatch — a mutation rejected here never
      // reaches the upstream, which is the only point at which rejecting it
      // is free. Unlike the response-side allowlist, there is no "filter it
      // out and continue" option: a caller asking to write a field they may
      // not write is making a request nobody can partially honor without
      // silently writing something other than what they asked for.
      //
      // `grant.writes` is deny-by-default and carries an entry for every
      // granted write tool, so a role that grants the tool but declares no
      // `writes` allowlist lands here with an empty list and every field is
      // refused. (`lib/config/load.ts` rejects that combination at boot, so
      // it should be unreachable from committed config — this is the runtime
      // half of the same rule, and it must not depend on the boot check
      // having run.)
      if (tool.write) {
        const fields = Object.hasOwn(rawArgs as Record<string, Json>, tool.write.fieldsFrom)
          ? (rawArgs as Record<string, Json>)[tool.write.fieldsFrom]
          : undefined;
        const writeProblems =
          fields === undefined
            ? [`argument "${tool.write.fieldsFrom}" is required for a write`]
            : writableFieldProblems(fields, grant.writes.get(tool.name) ?? []);

        if (writeProblems.length > 0) {
          await safeAudit(
            deps,
            {
              orgId: principal.orgId,
              userId: principal.userId,
              principalKind: principalKindOf(principal),
              app: entry.app,
              tool: tool.name,
              decision: "denied_bad_args",
              args: rawArgs,
              error: writeProblems.join("; "),
              durationMs: Date.now() - started,
              ...(unknownRoles.length > 0 ? { unknownRoles } : {}),
            },
            redact,
          );
          return json(rpcError(id, INVALID_PARAMS, writeProblems[0]));
        }
      }

      try {
        // Building the adapter context now lives inside the `try` (Task 11 fix round 1,
        // finding I6): a failure here (a malformed transport config, a secret-reader that
        // throws on construction) is a tool-call failure like any other and must produce a
        // `decision: "error"` audit row, not an uncaught exception with zero rows.
        const ctx = await deps.buildContext(entry);
        const raw = await deps.runTool(entry, tool, rawArgs, ctx);

        // `Grant.fields` values are `readonly string[]` and frozen (a Grant is a plausible
        // thing to cache, shared across callers) — copied here into a plain, mutable array
        // before it reaches `filterFields`, which types its `allow` parameter as `string[]`.
        const allow = [...(grant.fields.get(tool.name) ?? [])];

        // Field filtering happens here, on the adapter's return value, in the handler — never
        // inside `runTool` and never inside an adapter. That is what makes it structurally
        // impossible for an adapter author to leak a field by forgetting to filter.
        //
        // Task 11 fix round 1, finding C1 (CRITICAL): whether this is a "list" result must be
        // decided from `tool.list` — a reviewed, config-controlled fact — never from whether
        // the *upstream payload* happens to carry a key named `items`. The previous version
        // used `Array.isArray(rawRecord?.items)`, which let the *upstream*, not the gateway,
        // choose the unfiltered-spread branch: Service Fusion invoices/estimates legitimately
        // carry a line-item array under `items` on an otherwise single-record payload, so a
        // single-record tool's response would spread every other top-level field — including
        // ones the role's allowlist explicitly excludes — completely unfiltered.
        const isListResult = tool.list !== undefined;
        const rawRecord = raw as Record<string, Json>;

        // Task 11 fix round 2, finding C: the list envelope is built explicitly — naming
        // exactly `items`, `truncated`, `totalCount` — rather than by spreading `...rawRecord`
        // and overwriting `items` afterward. Spreading was safe only as long as `runTool`
        // happens to return the closed literal `{items, truncated, totalCount?}` for a list
        // tool, which is a cross-module invariant this file has no test asserting and no way
        // to enforce; a future `paginate`/`compose` hook returning an extra top-level field
        // (or any other change to that shape) would reopen the exact C1 leak with zero signal
        // here. Naming the three fields explicitly means an unexpected extra key can only ever
        // be dropped, never forwarded, regardless of what `runTool` returns.
        const filtered: Json = isListResult
          ? {
              items: filterFields(rawRecord.items, allow),
              truncated: rawRecord.truncated,
              ...(rawRecord.totalCount !== undefined ? { totalCount: rawRecord.totalCount } : {}),
            }
          : filterFields(raw, allow);

        const filteredRecord = filtered as Record<string, Json>;
        const count = Array.isArray(filteredRecord?.items) ? (filteredRecord.items as Json[]).length : undefined;

        await safeAudit(
          deps,
          {
            orgId: principal.orgId,
            userId: principal.userId,
            principalKind: principalKindOf(principal),
            app: entry.app,
            tool: tool.name,
            decision: "allowed",
            args: rawArgs,
            resultCount: count,
            durationMs: Date.now() - started,
            ...(unknownRoles.length > 0 ? { unknownRoles } : {}),
          },
          redact,
        );

        // `truncated`/`totalCount`, when the underlying tool is a list tool that hit
        // `maxPages`, are named explicitly in the envelope built above — the response says so
        // explicitly, never silently returning a partial result as if it were complete.
        return json(
          rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(filtered) }],
          }),
        );
      } catch (e) {
        const detail = scrubErrorDetail(safeErrorMessage(e), rawArgs, redact);
        await safeAudit(
          deps,
          {
            orgId: principal.orgId,
            userId: principal.userId,
            principalKind: principalKindOf(principal),
            app: entry.app,
            tool: tool.name,
            decision: "error",
            args: rawArgs,
            ...(e instanceof UpstreamError ? { upstreamStatus: e.status } : {}),
            error: detail,
            durationMs: Date.now() - started,
            ...(unknownRoles.length > 0 ? { unknownRoles } : {}),
          },
          redact,
        );
        // Task 11 fix round 1, finding C2 (CRITICAL): the client response must stay generic.
        // `detail` (an `UpstreamError`'s message embeds the upstream URL, the query string
        // built from the caller's own arguments, and — via `summarize`'s JSON branch, up to
        // 300 raw bytes of the upstream body) is exactly the kind of thing field filtering
        // exists to keep out of the response, reached through an entirely different door: no
        // filter runs on an error path at all. The same reasoning already applied to the
        // auth-infrastructure-failure branch above applies here — the full detail belongs in
        // the audit row (`error`/`upstreamStatus`, already set above) and, if useful, a
        // server-side log, never in what goes back over the wire.
        logFailure("mcp.tool_call_failed", detail);
        // Task 11 fix round 2, finding D: a stable class, never a status/URL/body — see
        // `failureClass`'s doc comment.
        return json(rpcError(id, INTERNAL_ERROR, `tool call failed: ${failureClass(e)}`));
      }
    }

    default:
      return json(rpcError(id, METHOD_NOT_FOUND, `unknown method: ${rpc.method ?? "(missing)"}`));
  }
}
