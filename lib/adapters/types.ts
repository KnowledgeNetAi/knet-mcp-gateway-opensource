import type { AppConfig, Json, ToolDef } from "@/lib/types";
import type { Http } from "@/lib/http/client";
import type { UpstreamError } from "@/lib/http/errors";

export interface UpstreamRequest {
  method: "GET" | "POST" | "PATCH";
  url: string;
  headers: Record<string, string>;
  /** Serialized JSON body, for a POST search. Absent on every GET. */
  body?: string;
}

export interface AdapterContext {
  http: Http;
  secret(path: string): Promise<string>;
  config: AppConfig;
  log(event: string, fields?: Record<string, unknown>): void;
}

/** Extra, runtime-computed inputs a buildRequest hook needs but must not compute itself. */
export interface BuildRequestInfo {
  /** The page number the runtime is currently fetching (1-based). Ignoring this and
   *  always building the same URL is the most common buildRequest bug — see Task 9
   *  fix round 1, finding 9. */
  page: number;
  /** The opaque next-page token the PREVIOUS response carried, for a
   *  `style: "cursor"` tool — `undefined` on the first page, and always
   *  `undefined` for page/offset tools, whose position is computable from
   *  `page` alone. A cursor hook has no way to derive this itself (the
   *  runtime, not the hook, reads it from the raw response), so ignoring it
   *  re-fetches page one forever. */
  cursor?: string;
  /** The headers the runtime already computed (Authorization, from either
   *  adapter.authenticate or getUpstreamToken). A hook that builds its own headers
   *  from scratch silently drops these unless it merges them in. */
  headers: Record<string, string>;
}

/**
 * The context handed to the two hooks that may issue their own upstream reads:
 * `compose` and `onUpstreamError`. Deliberately NOT an `AdapterContext`: it carries no
 * `http` (an unpinned, uncapped client) and no `secret` (a Vault reader with no per-app
 * scoping at runtime), so `get` really is the only way these hooks reach the upstream, and
 * they cannot read any credential at all. It is built by `runTool` from trusted values
 * (never from a hook's clone), so it:
 *  - resolves `path` against `config.baseUrl` and refuses any URL whose origin or base
 *    path differs, so the bearer token can never be sent to another host;
 *  - attaches exactly the headers a declarative request gets (Authorization plus the
 *    app's resolved `requestHeaders`);
 *  - is GET-only, and goes through `ctx.http`, so throttle, timeout and retry apply;
 *  - is capped at `MAX_ADAPTER_UPSTREAM_CALLS` per tool call. A composite tool is for a
 *    handful of related reads; portfolio fan-out belongs in a sync job. The cap counts
 *    `get` calls, not HTTP attempts: each call still runs the app's retry ladder and
 *    timeout, so the worst case is cap × `transport.retry.attempts` requests and
 *    cap × `transport.timeoutMs` of wall time. Keep composite tools on apps with modest
 *    transport settings, and always `await` every `get` — an un-awaited one that fails is an
 *    unhandled rejection.
 *  - refuses `%2f`/`%5c` (an upstream that decodes before routing would escape the base
 *    path), and `?`/`#` (query goes in `query`, never smuggled into `path`).
 */
export interface UpstreamContext {
  config: AppConfig;
  log(event: string, fields?: Record<string, unknown>): void;
  get(path: string, query?: Record<string, string>): Promise<Json>;
}

/** Every hook optional. Absent hooks fall back to declarative api.json behavior. */
export interface Adapter {
  authenticate?(ctx: AdapterContext): Promise<Record<string, string>>;
  buildRequest?(tool: ToolDef, args: Json, ctx: AdapterContext, info: BuildRequestInfo): UpstreamRequest;
  paginate?(data: unknown, req: UpstreamRequest): { items: Json[]; next?: UpstreamRequest };
  mapItem?(item: Json, tool: ToolDef, ctx: AdapterContext): Json;
  /** Alternative entry point: replaces buildRequest/send/paginate entirely. Rejected by
   *  the runtime if the tool also declares a `request` or `list` block (ambiguous about
   *  which one runs) — see lib/config/schema.test.ts and Task 9 fix round 1, finding 7. */
  compose?(args: Json, tool: ToolDef, ctx: UpstreamContext): Promise<Json>;
  /**
   * Called when a declarative request fails with an `UpstreamError`, after the transport's
   * retries. May return a DIFFERENT `UpstreamError` (e.g. correct an upstream that answers
   * a nonexistent id with a 500) — never data: a failed call stays failed, for the audit row
   * and for the caller. Anything other than an `UpstreamError` returned, or a throw from the
   * hook itself, and the runtime rethrows the ORIGINAL error.
   */
  onUpstreamError?(err: UpstreamError, args: Json, ctx: UpstreamContext): Promise<UpstreamError>;

  // `parseResponse` and `decodeError` were removed for phase 1 (Task 9 fix round 1,
  // finding 6): neither had a call site in runTool, so declaring them was a silent
  // no-op for any adapter author who implemented one. lib/http/client.ts already owns
  // JSON parsing and HTML error decoding and is not being reopened to thread hooks
  // through it. A non-JSON upstream, or one needing custom error decoding, uses
  // `compose` until phase 2 wires these through properly.
}

/**
 * The code half of one app, `orgs/<org>/<app>/adapter.ts`, keyed by TOOL. Per tool rather than
 * per app because `runTool` rejects a `compose` hook on a tool that declares a `request` — an
 * app-wide adapter with one composite tool would break every declarative tool beside it.
 * Registered in `lib/adapters/registry.ts`; `loadCatalog` checks every key names a real tool.
 */
export interface AppAdapter {
  tools: Readonly<Record<string, Adapter>>;
}

/** Per tool call. See `UpstreamContext`. */
export const MAX_ADAPTER_UPSTREAM_CALLS = 10;
