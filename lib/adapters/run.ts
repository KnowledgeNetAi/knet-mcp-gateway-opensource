import type { AppEntry, Json, ToolDef } from "@/lib/types";
import type { Adapter, AdapterContext, UpstreamContext, UpstreamRequest } from "./types";
import { MAX_ADAPTER_UPSTREAM_CALLS } from "./types";
import { getUpstreamToken } from "./auth";
import { UpstreamError } from "@/lib/http/errors";

// Every hook name `Adapter` declares. This list exists specifically to be
// checked, at runtime, against whatever hooks an adapter instance actually
// implements (see `hasHooks` below), so it must never fall out of sync with
// the interface it mirrors -- checked in both directions, at compile time:
//   - `satisfies readonly (keyof Adapter)[]` catches an entry that is *not*
//     a real key of Adapter (a typo, or a hook renamed/removed from the
//     interface).
//   - The exhaustiveness check just below catches the other direction --
//     `Adapter` gaining a hook that isn't listed here. `satisfies` alone
//     does NOT catch this (it only constrains each *listed* entry to be a
//     valid key; it never requires every key to be listed) -- verified
//     directly before relying on it: a scratch `keyof Adapter` with an
//     extra member and an un-updated `HOOK_NAMES` compiles clean under
//     `satisfies` alone, silently reopening this exact hole for the next
//     hook someone adds.
const HOOK_NAMES = [
  "authenticate",
  "buildRequest",
  "paginate",
  "mapItem",
  "compose",
  "onUpstreamError",
] as const satisfies readonly (keyof Adapter)[];
// If `Adapter` gains a hook not listed above, `keyof Adapter` stops
// extending `(typeof HOOK_NAMES)[number]` and this line fails to compile.
const _hookNamesAreExhaustive: keyof Adapter extends (typeof HOOK_NAMES)[number] ? true : never = true;
void _hookNamesAreExhaustive;

// Dot-path lookup used for pageCountAt/totalCountAt/itemsAt. Splits on a
// literal "." with no escape mechanism for a field name that itself contains
// a dot (e.g. a field literally named "a.b"). None of this codebase's actual
// configs need that, and adding escaping is not worth the complexity for a
// case that hasn't come up — flagged here rather than fixed (Task 9 fix
// round 1, deferred item).
function at(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  );
}

/**
 * Interpolate `{{name}}` placeholders for a QUERY value. Returns whether
 * every placeholder actually resolved: a query param whose value depends on
 * a missing arg is omitted entirely by the caller rather than sent as an
 * empty string — for a search/filter API, "filter by empty string" and "no
 * filter at all" are different queries, and silently sending the former
 * for the latter is a silent wrong-results bug (Task 9 fix round 1, finding
 * 11).
 */
function interpolateQuery(template: string, args: Json): { value: string; resolved: boolean } {
  let resolved = true;
  const value = template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = (args as Record<string, Json>)[k];
    if (v === undefined || v === null) {
      resolved = false;
      return "";
    }
    return String(v);
  });
  return { value, resolved };
}

/** A string that is EXACTLY one placeholder, e.g. `"{{email}}"` — substituted as a
 *  typed value rather than spliced into a string. */
const WHOLE_PLACEHOLDER = /^\{\{(\w+)\}\}$/;

/**
 * Interpolate a JSON request-body template for a POST search.
 *
 * Two behaviors it does NOT share with `interpolateQuery`, both load-bearing:
 *
 * 1. **Types survive.** A value that is exactly `"{{limit}}"` substitutes the
 *    argument itself — a number stays a number, an array stays an array —
 *    because a search body is typed JSON, not a query string. HubSpot rejects
 *    `{"limit": "100"}` where it accepts `{"limit": 100}`.
 *
 * 2. **A nested object is all-or-nothing; the ROOT drops per-property.** A
 *    HubSpot filter is `{propertyName, operator, value}`; if `value`'s
 *    placeholder is unresolved, dropping only that key leaves a malformed
 *    filter that means something different from what the config author wrote,
 *    so the whole object is treated as unresolved and removed from its array.
 *    An array whose template had entries but resolved to none is unresolved in
 *    turn, which is what collapses `filterGroups` cleanly to "no filters" when
 *    a caller supplies no optional arguments. The root object is the request
 *    itself rather than a composite value, so there — and only there —
 *    unresolved properties are dropped individually, exactly as
 *    `interpolateQuery`'s caller drops an unresolved query parameter.
 *
 * A whole-value placeholder may only substitute a primitive or an array of
 * primitives. An object-valued argument would splice caller-controlled
 * STRUCTURE into the request — new filter groups, a different operator — which
 * is a different request than the tool's own reviewed config declares, under
 * this gateway's credentials. `validateArgs` (lib/mcp/handler.ts) already
 * enforces a declared `type`, so this is the backstop for a property that
 * declares none, and it throws rather than coercing.
 */
function interpolateBodyValue(
  node: unknown,
  args: Json,
  key: string,
  writableArg?: string,
): { value: Json; resolved: boolean } {
  if (typeof node === "string") {
    const whole = WHOLE_PLACEHOLDER.exec(node);
    if (whole) {
      const v = (args as Record<string, Json>)[whole[1]];
      if (v === undefined || v === null) return { value: null, resolved: false };
      const primitive = (x: Json) => x === null || typeof x !== "object";
      // The structure-injection guard is lifted for exactly one argument: the
      // field bag a write tool declares via `write.fieldsFrom`. That argument
      // is SUPPOSED to be an object, and it is safe to be one only because
      // every key in it has already been checked against the caller's
      // per-role write allowlist (lib/mcp/handler.ts, before this runs) and
      // every value constrained to a scalar. No allowlist, no exemption —
      // which is why this takes the argument NAME from the tool's own
      // reviewed config rather than a boolean the caller could influence.
      if (whole[1] === writableArg) {
        if (primitive(v) || Array.isArray(v)) {
          throw new Error(`argument "${whole[1]}" must be an object of fields`);
        }
        return { value: v, resolved: true };
      }
      if (!primitive(v) && !(Array.isArray(v) && v.every(primitive))) {
        throw new Error(`argument "${whole[1]}" must not be an object in a request body`);
      }
      return { value: v, resolved: true };
    }
    // Embedded among other text (e.g. "%{{term}}%"): string interpolation,
    // with the same unresolved semantics a query value has.
    return interpolateQuery(node, args);
  }

  if (Array.isArray(node)) {
    const out: Json[] = [];
    for (const el of node) {
      const r = interpolateBodyValue(el, args, key, writableArg);
      if (r.resolved) out.push(r.value);
    }
    // Emptied by dropping, rather than declared empty: the template asked for
    // entries and none survived, so this array carries no meaning and its
    // holder should drop it too.
    if (node.length > 0 && out.length === 0) return { value: out, resolved: false };
    return { value: out, resolved: true };
  }

  if (node !== null && typeof node === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const r = interpolateBodyValue(v, args, k, writableArg);
      if (!r.resolved) return { value: {}, resolved: false };
      out[k] = r.value;
    }
    return { value: out, resolved: true };
  }

  return { value: (node ?? null) as Json, resolved: true };
}

/** Root-level interpolation: unresolved properties are dropped, not fatal. See above. */
function interpolateBody(
  template: Record<string, unknown> | string,
  args: Json,
  writableArg?: string,
): Json {
  if (typeof template === "string") {
    const r = interpolateBodyValue(template, args, "", writableArg);
    if (!r.resolved) return {};
    return r.value;
  }
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(template)) {
    const r = interpolateBodyValue(v, args, k, writableArg);
    if (r.resolved) out[k] = r.value;
  }
  return out;
}

/**
 * Interpolate `{{name}}` placeholders for a PATH segment. Unlike a query
 * value (set via URLSearchParams, which encodes automatically), a path is
 * built by raw string concatenation, so every substituted value is
 * percent-encoded here explicitly. Without this, an arg containing "/"
 * would inject an extra path segment (Task 9 fix round 1, finding 8).
 *
 * A missing/null arg throws rather than substituting "": a path segment,
 * unlike a query filter, has no "omit it" reading -- an unresolved
 * placeholder would silently produce "//" in the URL, which many APIs route
 * to the collection endpoint rather than 404ing (Task 9 fix round 2,
 * finding A). A caller-supplied *empty string* (or an array that stringifies
 * to one, e.g. `[]`/`[""]`) reaches the exact same "//" shape via a
 * different mechanism -- resolved, but empty, rather than unresolved -- so
 * it is rejected the same way (Task 9 fix round 3, finding 2).
 *
 * A raw value of exactly "." or ".." is rejected outright rather than
 * merely encoded. `encodeURIComponent` leaves "." unescaped (it's an RFC
 * 3986 unreserved character), so those two exact values alone would survive
 * encoding as literal dot-segments; the WHATWG URL parser then
 * "remove-dot-segments" normalizes them, collapsing or dropping a whole path
 * segment -- not merely this one -- and redirecting the request onto a
 * *different* upstream path than the tool's own config declares, under this
 * gateway's own credentials (Task 9 fix round 2, finding A -- the round 1
 * fix only handled "/", which is necessary but not sufficient). No other
 * raw value can reach this outcome: every other character the URL parser
 * treats as dot-segment-relevant ("%2e" in any of its four spec-defined
 * combinations) requires a literal "%" in the *resulting* URL, and
 * `encodeURIComponent` always escapes a literal "%" in the input (to "%25"),
 * so an argument that is literally the text "%2e" or "%2e%2e" reaches the
 * URL as "%252e"/"%252e%252e" -- not a form the parser recognizes as a dot
 * segment. Verified directly against Node's URL implementation, not just
 * the spec text.
 */
function interpolatePath(template: string, args: Json): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = (args as Record<string, Json>)[k];
    if (v === undefined || v === null) {
      throw new Error(`missing required path argument "${k}"`);
    }
    const raw = String(v);
    // An empty string is the other way a placeholder can resolve to nothing
    // in the URL: `raw === ""` produces the same "//" collection-endpoint
    // shape a missing arg did before that was rejected above -- the mechanism
    // differs (a resolved-but-empty value vs. an unresolved one) but the
    // resulting URL is identical, so it gets the identical treatment (Task 9
    // fix round 3, finding 2 -- an array arg like `[]` or `[""]` also
    // stringifies to `""` via `String(v)` above and is caught by this same
    // check).
    if (raw.length === 0 || raw === "." || raw === "..") {
      throw new Error(`path argument "${k}" must not be empty, "." or ".."`);
    }
    // A slash is encoded below, but an upstream or proxy that decodes %2F
    // before routing would still see a second path segment. An id never
    // legitimately contains one, so refuse it rather than rely on encoding.
    if (/[\/\\]/.test(raw)) {
      throw new Error(`path argument "${k}" must not contain "/" or "\\"`);
    }
    return encodeURIComponent(raw);
  });
}

/**
 * Run one tool. Returns { items, truncated, totalCount } for list tools, or the
 * raw object for single-record tools.
 *
 * This function never sees a Principal and never filters fields — the caller
 * does both. Keeping them out here is what stops an adapter from leaking.
 */
export async function runTool(
  entry: AppEntry,
  tool: ToolDef,
  args: Json,
  ctx: AdapterContext,
  adapter: Adapter = {},
): Promise<Json> {
  // compose is an alternative entry point, not a pipeline stage: when present
  // it replaces buildRequest/send/paginate entirely. A tool that declares a
  // `request` or `list` block is a declarative tool that expects the normal
  // fetch/pagination pipeline to run for it; pairing either with an adapter
  // compose hook is ambiguous about which one actually runs (and, for
  // `list`, would let compose issue unbounded requests and skip `truncated`
  // entirely — Task 9 fix round 1, finding 7), so it is rejected rather than
  // silently preferring one. (See also lib/config/schema.test.ts, which
  // documents this same expectation from the config side: `compose` is
  // never a config key, precisely because this runtime guard is what
  // arbitrates the request-vs-compose ambiguity, not the schema.)
  if (adapter.compose && (tool.request || tool.list)) {
    throw new Error(`tool ${tool.name} defines compose alongside a request or list block`);
  }

  // `tool` and `ctx.config` are typically long-lived objects shared by every
  // future call for this (org, app, tool) — the boot-time config catalog
  // holds one instance for the process lifetime. Every hook here — compose
  // included — is handed `tool` and/or `ctx` (transitively `ctx.config`);
  // without this, a hook that mutates either one in place (accidentally or
  // otherwise) — e.g. bumping `tool.list.pagination.maxPages`, or renaming
  // the tool — would corrupt every *later* call to this tool, for every
  // caller, until the process restarts. maxPages must stay something the
  // runtime enforces, never something a hook can move. This clone must
  // happen before the compose branch below returns: an earlier version of
  // this function cloned after that return, which meant compose alone was
  // exempt from the whole protection (Task 9 fix round 1, finding 1 —
  // CRITICAL). Cloning is skipped entirely when no hook is registered at
  // all, since there is then nothing that could see, let alone mutate, the
  // clone. Checked via HOOK_NAMES + `typeof adapter[k] === "function"` --
  // resolved through the prototype chain, exactly like every actual hook
  // call below (`adapter.mapItem(...)`, etc.) resolves its own lookup. An
  // earlier version of this check used `Object.keys(adapter).length > 0`,
  // which only sees *own enumerable* keys: a class instance
  // (`class SFAdapter implements Adapter {}`), an `Object.create(base)`
  // adapter, or a hook installed via `Object.defineProperty` all have
  // `Object.keys(adapter) === []` while their hooks still run -- silently
  // turning `hasHooks` (and therefore cloning) off for exactly the adapter
  // shapes idiomatic TypeScript produces, reopening finding 1 for any of
  // them (Task 9 fix round 3, finding 1 -- CRITICAL). This check must use
  // the same lookup semantics as the call, not a proxy for them.
  const hasHooks = HOOK_NAMES.some((k) => typeof adapter[k] === "function");
  const safeTool = hasHooks ? structuredClone(tool) : tool;
  const safeCtx: AdapterContext = hasHooks
    ? {
        ...ctx,
        config: structuredClone(ctx.config),
        // `ctx.http` is the long-lived, per-app Http client -- it holds
        // throttle state across every call to this app, by every caller --
        // the same shape of shared object `tool`/`ctx.config` are, and is
        // *not* touched by the structuredClone above (structuredClone can't
        // clone an object holding a function, and cloning it would also
        // detach it from the real throttle state it exists to hold). A hook
        // doing `ctx.http.request = <injected fn>` was, before this fix,
        // reassigning a property on the very object the real `ctx.http` is
        // -- the shallow spread above left `http` un-overridden, so
        // `safeCtx.http === ctx.http` -- silently replacing the transport
        // for every later call on this `ctx`, hook-free calls included
        // (Task 9 fix round 2, finding B; same shape as finding 1). A fresh
        // façade object, forwarding to the real client, means a hook can
        // only ever mutate its own throwaway copy.
        http: { request: (url, init, opts) => ctx.http.request(url, init, opts) },
      }
    : ctx;

  // Upstream headers, resolved once per call and only when first needed — a compose hook
  // that never calls `get` never mints a token. Shared by the declarative path below and by
  // `get`, so an adapter's reads carry exactly the headers a declarative request does.
  let headersPromise: Promise<Record<string, string>> | undefined;
  const upstreamHeaders = (): Promise<Record<string, string>> =>
    (headersPromise ??= (async () => {
      const baseHeaders = adapter.authenticate
        ? await adapter.authenticate(safeCtx)
        : entry.config.auth.type === "none"
          ? {}
          : { Authorization: `Bearer ${await getUpstreamToken(entry, ctx)}` };

      const resolvedRequestHeaders = entry.config.requestHeaders
        ? Object.fromEntries(
            await Promise.all(
              Object.entries(entry.config.requestHeaders).map(
                async ([name, path]) => [name, await ctx.secret(path)] as const,
              ),
            ),
          )
        : {};

      return { ...baseHeaders, ...resolvedRequestHeaders };
    })());

  // `get`: the only door from adapter code to the upstream with this app's credentials.
  // Built from `entry` and `ctx` — the trusted originals, never a hook's clone — so a hook
  // cannot repoint it by mutating its own `config.baseUrl`. The resolved URL must keep the
  // base URL's origin AND sit under its path: `//host`, `/../`, and `@host` tricks all
  // normalize to something that fails one of the two checks, before any request is sent.
  const base = new URL(entry.config.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  let upstreamCalls = 0;
  const get = async (path: string, query?: Record<string, string>): Promise<Json> => {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
      throw new Error(`tool ${tool.name}: adapter get path must start with a single "/", got ${JSON.stringify(path)}`);
    }
    if (/[?#\\]|%2f|%5c/i.test(path)) {
      throw new Error(`tool ${tool.name}: adapter get path may not contain ?, #, a backslash, or an encoded slash`);
    }
    const url = new URL(entry.config.baseUrl.replace(/\/+$/, "") + path);
    if (url.origin !== base.origin || !(url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))) {
      throw new Error(`tool ${tool.name}: adapter get refused a URL outside the app's baseUrl`);
    }
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    // Counted before the request, so a hook looping on failures is still bounded.
    if (++upstreamCalls > MAX_ADAPTER_UPSTREAM_CALLS) {
      throw new Error(`tool ${tool.name}: adapter exceeded ${MAX_ADAPTER_UPSTREAM_CALLS} upstream calls`);
    }
    const { data } = await ctx.http.request(url.toString(), {
      method: "GET",
      headers: { ...(await upstreamHeaders()), Accept: "application/json" },
    });
    return data as Json;
  };
  // config and log only — no `http`, no `secret` (see UpstreamContext). `config` is the
  // hook's own clone when hooks are present, so mutating it cannot reach `get`.
  const upstreamCtx: UpstreamContext = { config: safeCtx.config, log: safeCtx.log, get };

  if (adapter.compose) {
    try {
      return await adapter.compose(args, safeTool, upstreamCtx);
    } finally {
      ctx.log("adapter.compose", { tool: tool.name, upstreamCalls });
    }
  }
  if (!tool.request) throw new Error(`tool ${tool.name} has neither request nor compose`);

  // Every declarative upstream request goes through here, so `onUpstreamError` sees every
  // failure. The hook may swap in a different UpstreamError — never data — and a hook that
  // throws or returns anything else leaves the ORIGINAL error in place: a broken hook must
  // not be able to turn a real failure into a different, invented one.
  const send: AdapterContext["http"]["request"] = async (url, init, opts) => {
    try {
      return await ctx.http.request(url, init, opts);
    } catch (e) {
      if (!(e instanceof UpstreamError) || !adapter.onUpstreamError) throw e;
      // Captured before the hook runs: a hook that mutates `e` in place and returns it must
      // not erase the real upstream status from the log.
      const originalStatus = e.status;
      let replaced: unknown;
      try {
        replaced = await adapter.onUpstreamError(e, args, upstreamCtx);
      } catch {
        throw e;
      }
      // The replacement must still be an error status: anything outside 400–599 would make
      // the audit row read as something other than a failed call.
      if (
        !(replaced instanceof UpstreamError) ||
        !Number.isInteger(replaced.status) ||
        replaced.status < 400 ||
        replaced.status > 599
      ) {
        e.status = originalStatus;
        throw e;
      }
      // A hook that hands back the same error unchanged rewrote nothing; don't log that it did.
      if (replaced === e && replaced.status === originalStatus) throw e;
      ctx.log("adapter.upstream_error_rewritten", { tool: tool.name, from: originalStatus, to: replaced.status });
      throw replaced;
    }
  };

  const headers = await upstreamHeaders();

  const build = (page: number, cursor?: string): UpstreamRequest => {
    if (adapter.buildRequest) {
      // `headers` (the outer, once-computed const) is passed by reference
      // and `build()` runs once per page: a hook that mutates `info.headers`
      // in place instead of returning its own object -- e.g. deleting
      // `Authorization` to force a fallback path -- would otherwise mutate
      // the *same* object every later page of this call reads too. Scoped
      // to one `runTool` call (not shared across calls the way `tool`/
      // `ctx.config`/`ctx.http` are), so this is a single-call correctness
      // fix, not a cross-tenant one (Task 9 fix round 3, finding 4).
      const built = adapter.buildRequest(safeTool, args, safeCtx, { page, cursor, headers: { ...headers } });
      // Merge, don't replace: `built.headers` is whatever the hook chose to
      // return, which -- unless the hook remembered to spread `info.headers`
      // in itself -- silently drops the Authorization header this function
      // just computed (via adapter.authenticate or getUpstreamToken). This
      // is the hook a new customer API is most likely to write, so making
      // the bearer token unlosable here is structural, not left to every
      // hook author to remember (Task 9 fix round 2, finding E). The hook's
      // own headers still win per-key if it does set one, including
      // Authorization itself.
      return { ...built, headers: { ...headers, ...built.headers } };
    }
    const url = new URL(entry.config.baseUrl + interpolatePath(tool.request!.path, args));
    // Defaults are fallbacks, not overrides. Apply them first so a resolved,
    // caller-supplied query argument below can replace the default. Applying
    // them afterward made an advertised argument such as `sort=dateAdded`
    // impossible to honor whenever the tool also declared a sort default.
    for (const [k, v] of Object.entries(tool.list?.defaults ?? {})) url.searchParams.set(k, v);
    for (const [k, v] of Object.entries(tool.request!.query ?? {})) {
      // A whole-placeholder array represents a repeated query parameter
      // (`filters[departments][]=HVAC&filters[departments][]=Plumbing`).
      // Embedded placeholders remain strings; only the exact whole-value
      // form can opt into repetition, keeping the configured query key and
      // structure fixed.
      const whole = WHOLE_PLACEHOLDER.exec(v);
      const queryArg = whole ? (args as Record<string, Json>)[whole[1]] : undefined;
      const inputProperties = safeTool.input.properties;
      const queryArgSchema =
        whole && inputProperties && typeof inputProperties === "object" && !Array.isArray(inputProperties)
          ? (inputProperties as Record<string, unknown>)[whole[1]]
          : undefined;
      const declaresArray =
        queryArgSchema && typeof queryArgSchema === "object" && !Array.isArray(queryArgSchema) &&
        (queryArgSchema as Record<string, unknown>).type === "array";
      if (Array.isArray(queryArg) && declaresArray) {
        for (const item of queryArg) {
          if (item !== null && typeof item === "object") {
            throw new Error(`argument "${whole![1]}" must contain only primitive query values`);
          }
          url.searchParams.append(k, String(item));
        }
        continue;
      }
      const { value, resolved } = interpolateQuery(v, args);
      if (resolved) url.searchParams.set(k, value);
    }
    // Built before pagination so a cursor tool paging `in: "body"` has
    // somewhere to write. `body` stays undefined for every GET, and the
    // schema's method union guarantees a POST always has a template.
    const body =
      tool.request!.method === "GET"
        ? undefined
        : interpolateBody(tool.request!.body ?? {}, args, tool.write?.fieldsFrom);

    if (tool.list) {
      const p = tool.list.pagination;
      if (p.style === "offset") {
        url.searchParams.set(p.params?.limit ?? "limit", String(p.perPage));
        url.searchParams.set(p.params?.offset ?? "offset", String((page - 1) * p.perPage));
      } else if (p.style === "cursor") {
        // Omitted entirely on the first page rather than sent empty: for
        // HubSpot an empty `after` is a 400, and more generally "start at the
        // beginning" and "resume from the empty-string cursor" are different
        // requests — the same reason interpolateQuery drops an unresolved
        // query param instead of sending "".
        if (p.in === "body" && body && typeof body === "object" && !Array.isArray(body)) {
          // Written AFTER interpolation, so these are never something a
          // caller's argument can reach: a template placeholder resolving to
          // the same key is overwritten here, and maxPages stays the
          // runtime's number rather than one an argument could move.
          body[p.params?.limit ?? "limit"] = p.perPage;
          if (cursor !== undefined) body[p.params?.cursor ?? "after"] = cursor;
        } else {
          url.searchParams.set(p.params?.limit ?? "limit", String(p.perPage));
          if (cursor !== undefined) url.searchParams.set(p.params?.cursor ?? "after", cursor);
        }
      } else {
        url.searchParams.set(p.params?.perPage ?? "per-page", String(p.perPage));
        url.searchParams.set(p.params?.page ?? "page", String(page));
      }
    }

    return {
      method: tool.request!.method,
      url: url.toString(),
      headers: {
        ...headers,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
  };

  if (!tool.list) {
    const req = build(1);
    // A mutation is retried on 429 and NOTHING else. A 429 was rejected
    // outright, so re-sending it applies the change exactly once; a 5xx or a
    // truncated response may mean the upstream already applied it, and
    // retrying would submit it twice. This is enforced by the runtime from
    // the tool's own `write` block rather than read from `transport.retry`,
    // because retry is configured per APP: a config author narrowing it for a
    // write tool would also narrow it for every read tool in the same app,
    // and one who forgot would silently get double-submits. Reads are
    // untouched and keep the app's configured policy.
    const { data } = await send(
      req.url,
      {
        method: req.method,
        headers: req.headers,
        ...(req.body === undefined ? {} : { body: req.body }),
      },
      tool.write ? { retryOn: ["429"] } : undefined,
    );
    const mapped = adapter.mapItem ? adapter.mapItem(data as Json, safeTool, safeCtx) : (data as Json);
    return mapped;
  }

  // Captured once, before any hook runs, from the trusted (non-cloned)
  // objects: these are the numbers this function promises the runtime — not
  // a hook — enforces. A hook can still mutate its own `safeTool` clone
  // freely; it can no longer move these.
  const { maxPages } = tool.list.pagination;
  // `pageCountAt` only exists on the "page" branch of the pagination union —
  // an offset-style tool (FieldEdge) has none, and reads as undefined here,
  // exactly like a page-style tool that simply never declared one. No
  // behavior change for either style: the loop below already treats a
  // missing pageCountAt as "no runtime-read signal, fall back to observing
  // an empty page" (see `exhausted`).
  const pageCountAt = tool.list.pagination.style === "page" ? tool.list.pagination.pageCountAt : undefined;
  // Captured from the trusted (non-cloned) tool for the same reason maxPages
  // is: this is the path the RUNTIME reads the next-page token from, and a
  // hook mutating its own clone must not be able to redirect it.
  const cursorAt = tool.list.pagination.style === "cursor" ? tool.list.pagination.cursorAt : undefined;
  const totalCountAt = tool.list.pagination.totalCountAt ?? "_meta.totalCount";
  const seen = new Set<unknown>();
  const items: Json[] = [];
  let pageCount = Infinity;
  // True once pageCountAt has resolved to a real, finite number at least
  // once. From that point on, pageCount is an authoritative runtime-read
  // signal about how much data actually exists, and nothing derived from a
  // hook's own output (specifically: a paginate hook returning zero items)
  // may veto what it says about truncation. Before that point, there is no
  // authoritative signal at all, and a directly-observed empty page is the
  // only evidence of completeness available (see `exhausted` below).
  let pageCountKnown = false;
  let totalCount: number | undefined;
  let page = 1;
  // The next-page token to send, for a cursor-style tool. `undefined` means
  // "first page" on the way in; on the way out of each iteration it means the
  // upstream reported no further page, which is the ONLY completeness signal
  // a cursor API gives.
  let cursor: string | undefined;
  // Set only when a page is observed to have zero items *and* pageCount was
  // never established from the raw response — i.e. we have no runtime-read
  // signal to trust, so a directly-observed empty page is accepted as proof
  // there is no more data. Once pageCountKnown is true, this must never be
  // set: a paginate hook returning `{items: []}` on a page the runtime
  // already knows (from pageCountAt) is not the last one must not be able to
  // report the result as complete — that is a hook vetoing a signal the
  // runtime itself read from the raw response (Task 9 fix round 1, finding
  // 2 — CRITICAL).
  //
  // Critically, "observed" means observed by the runtime, from the raw
  // response at the tool's own declared `itemsAt` path — never from
  // `paged.items` (round 1's fix left this reading `paged.items`, which is
  // whatever `adapter.paginate` chose to return; a paginate hook could
  // answer `{items: []}` on a page whose *raw* itemsAt array was non-empty,
  // and — as long as pageCountAt hadn't resolved on that same response —
  // still flip `truncated` to false, reopening finding 2 for exactly the
  // pageCountAt-inconsistent-per-page case. See `rawEmpty` below, and Task 9
  // fix round 2, finding D).
  let exhausted = false;

  while (page <= Math.min(maxPages, pageCount)) {
    const req = build(page, cursor);
    const { data } = await send(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body === undefined ? {} : { body: req.body }),
    });

    // Read the runtime's own truncation signals from the raw response
    // *before* handing that same response to adapter.paginate. paginate is a
    // hook (arbitrary adapter code) that receives `data` by reference; if it
    // ran first and happened to mutate the object in place (e.g. deleting or
    // rewriting `_meta.pageCount`), the read below would silently pick up
    // the tampered value instead of what the upstream API actually sent —
    // exactly the kind of silent truncation this field exists to prevent.
    if (pageCountAt) {
      const pc = Number(at(data, pageCountAt));
      if (Number.isFinite(pc)) {
        pageCount = pc;
        pageCountKnown = true;
      }
    }
    const tc = Number(at(data, totalCountAt));
    if (Number.isFinite(tc)) totalCount = tc;

    // Read here, from the RAW response, for exactly the reason pageCountAt is
    // read here: `adapter.paginate` receives `data` by reference and could
    // otherwise rewrite or delete the cursor before the runtime sees it —
    // making a truncated result report as complete, or sending the next page
    // request somewhere the tool's own config never pointed. A cursor is only
    // honored when it is a non-empty string; anything else (absent, null, a
    // number, an object) reads as "no further page", which is what every
    // cursor API's last page actually looks like.
    let nextCursor: string | undefined;
    if (cursorAt) {
      const c = at(data, cursorAt);
      if (typeof c === "string" && c.length > 0) nextCursor = c;
    }

    // Offset-style APIs report a total but no page count, so `pageCount` would
    // stay Infinity and `truncated` (below) would be true on EVERY call — even
    // one that returned the whole collection. Observed live on FieldEdge:
    // warehouse_search returned all 98 of 98 records and still reported
    // truncated, which tells a model to narrow a search that is already
    // complete.
    //
    // Deriving it from the total is legitimate for the same reason reading
    // `pageCountAt` is: `totalCount` was just read by the runtime from the RAW
    // response, above, before `adapter.paginate` is handed that response — so
    // this is a runtime-read signal, not a hook-supplied one, and the
    // "a hook must not be able to veto what the runtime read" invariant holds.
    if (tool.list!.pagination.style === "offset" && Number.isFinite(tc)) {
      pageCount = Math.max(1, Math.ceil(tc / tool.list!.pagination.perPage));
      pageCountKnown = true;
    }

    // Read independently of adapter.paginate, from the same trusted,
    // declarative path the default (no-adapter) extraction itself uses. This
    // is the runtime's own observation of whether the raw response actually
    // had any items — never derived from, and never overridable by, a
    // paginate hook's return value (Task 9 fix round 2, finding D).
    //
    // `rawItems == null` (an absent key, or a key explicitly `null`) counts
    // as empty here too, alongside a zero-length array: both are common,
    // ordinary ways for a real API to spell "no results" for a genuinely
    // complete answer -- restricting this to `Array.isArray` alone left a
    // page shaped `{}` or `{ items: null }` (or no response body at all)
    // indistinguishable from a *malformed* response, and reported as
    // truncated regardless of whether pageCountAt ever resolves (Task 9 fix
    // round 3, finding 3). Anything else that isn't an array (a string, a
    // number, an object without the expected key at a *different* path) is
    // still not treated as empty -- there's no way to tell "no results" from
    // "wrong shape" for those, so the safer direction (truncated) still wins.
    const rawItems = at(data, tool.list.itemsAt);
    const rawEmpty = rawItems == null || (Array.isArray(rawItems) && rawItems.length === 0);

    const paged = adapter.paginate
      ? adapter.paginate(data, req)
      : { items: (rawItems as Json[]) ?? [] };
    if (!Array.isArray(paged.items)) {
      throw new Error(`tool ${tool.name}: paginate did not return an items array`);
    }

    if (paged.items.length === 0) {
      // For a cursor API an empty page is NOT evidence of completeness — the
      // cursor is. A page carrying zero items and a next cursor is legal
      // (an upstream filter can empty out one window of a keyset scan) and
      // means "keep going"; treating it as the end would report a truncated
      // result as complete, which is the same class of defect as letting a
      // paginate hook veto pageCountAt. Bounded by maxPages like every other
      // path out of this loop, so following it cannot run away.
      if (cursorAt) {
        if (nextCursor) {
          cursor = nextCursor;
          page++;
          continue;
        }
        exhausted = true;
        break;
      }
      if (!pageCountKnown && rawEmpty) exhausted = true;
      break;
    }

    for (const raw of paged.items) {
      // Offset pagination over a non-unique sort key repeats rows at page
      // boundaries; dedupe rather than returning the duplicates. Only when
      // the field is actually present: treating a *missing* dedupeBy field
      // as if every row shared the value `undefined` would drop every row
      // after the first that lacks it, which is data loss, not dedup.
      if (tool.list.dedupeBy) {
        const id = (raw as Record<string, Json>)?.[tool.list.dedupeBy];
        if (id !== undefined) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
      }
      items.push(adapter.mapItem ? adapter.mapItem(raw, safeTool, safeCtx) : raw);
    }

    if (cursorAt) {
      // The absence of a next cursor is a cursor API's own statement that
      // this page was the last one — direct, runtime-read evidence of
      // completeness, the same standing `exhausted` already has for an
      // observed-empty page. Without it `pageCount` stays Infinity and every
      // cursor call would report truncated:true, including one that returned
      // the whole collection (the same defect fixed for offset-style tools
      // against FieldEdge's warehouse_search).
      if (!nextCursor) {
        exhausted = true;
        break;
      }
      cursor = nextCursor;
    }
    page++;
  }

  // `pageCount` starts at Infinity and only ever moves if pageCountAt is
  // configured *and* the upstream response actually carried it. If it never
  // does, `exhausted` (set only in that same case, directly from an observed
  // empty page — never from pageCountKnown being true) is the fallback
  // signal: without it, a tool with no pageCountAt would report
  // truncated:true forever, even when an empty page is direct proof there is
  // nothing left. Once pageCountKnown is true, `pageCount > maxPages` is
  // authoritative on its own and `exhausted` is guaranteed to be false (see
  // the guard above), so a hook cannot make this read false when the
  // runtime's own read of the raw response said there was more.
  const truncated = !exhausted && pageCount > maxPages;
  return { items, truncated, ...(totalCount === undefined ? {} : { totalCount }) } as Json;
}
