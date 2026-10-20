export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface RequestDef {
  /**
   * POST is admitted for READS ONLY — a search whose filter payload will not
   * fit in a query string (HubSpot's CRM search endpoints). The
   * read-only posture is kept structural rather than left to a comment: the
   * schema requires a POST tool to declare a `list` block, and a mutating
   * tool (create/update) has none, so it fails the build. Actual write
   * support is a separate change — `lib/policy/filter.ts` filters RESPONSES,
   * so nothing here constrains which fields a caller may write, and
   * `transport.retry` would re-submit a mutation on a 5xx.
   */
  method: "GET" | "POST" | "PATCH";
  path: string;
  query?: Record<string, string>;
  /**
   * JSON request body template for a POST, with `{{arg}}` placeholders.
   * Interpolated by `lib/adapters/run.ts`'s `interpolateBody`, which
   * preserves types (a whole-value `"{{limit}}"` substitutes the number, not
   * the string) and drops any branch whose placeholder did not resolve — so
   * an unsupplied optional filter disappears instead of becoming
   * filter-by-null.
   */
  /**
   * An object template, or a whole-value placeholder such as `{{fields}}`
   * for APIs whose mutation payload is the caller's reviewed field bag at
   * the JSON root rather than beneath a wrapper property.
   */
  body?: Record<string, unknown> | string;
}

// A discriminated union on `style`, not an enum plus an open `params` bag:
// an offset tool declaring a `page` parameter name (or a page tool declaring
// `offset`) is a config author's mistake, and this makes it a type/schema
// error instead of a silently-wrong query parameter.
export type PaginationDef =
  | {
      style: "page";
      perPage: number;
      maxPages: number;
      params?: { page?: string; perPage?: string };
      pageCountAt?: string;
      totalCountAt?: string;
    }
  | {
      style: "offset";
      perPage: number;
      maxPages: number;
      params?: { limit?: string; offset?: string };
      totalCountAt?: string;
    }
  | {
      // Cursor (a.k.a. keyset) paging: the next page is addressed by an
      // opaque token the PREVIOUS response carried, not by an index the
      // client computes. HubSpot CRM v3 is the first such API onboarded.
      // `cursorAt` is required, not optional with a default: there is no
      // universal spelling for where that token lives, and a config that
      // omitted it would fetch page one, find no cursor, and report a
      // complete result — silent truncation, the exact failure the rest of
      // this pipeline is built to make impossible.
      style: "cursor";
      perPage: number;
      maxPages: number;
      params?: { limit?: string; cursor?: string };
      /**
       * Where the limit and cursor parameters go. "query" (the default) is
       * the GET shape; "body" is required for a POST search, where HubSpot
       * reads `limit` and `after` from the JSON body and ignores them on the
       * query string — sending them to the wrong place silently returns
       * page one forever.
       */
      in?: "query" | "body";
      cursorAt: string;
      totalCountAt?: string;
    };

export interface ListDef {
  itemsAt: string;
  pagination: PaginationDef;
  defaults?: Record<string, string>;
  dedupeBy?: string;
}

/**
 * Marks a tool as a MUTATION, and says where caller-supplied fields enter the
 * request.
 *
 * Its presence — not the HTTP verb — is what makes a tool a write. POST is
 * ambiguous (HubSpot's search endpoints are POST reads), so the verb alone
 * cannot decide, and a bare `effect: "write"` flag would be a marker that
 * configures nothing. This block configures something load-bearing: without
 * it the runtime has no idea which argument to hold against the caller's
 * write allowlist, so a write tool cannot function without declaring it, and
 * cannot declare it without being recognized as a write.
 */
export interface WriteDef {
  /**
   * The name of the tool input argument carrying the caller's field bag (for
   * HubSpot, the object that lands at `properties` in the request body).
   * Every key of that object is checked against the caller's per-role write
   * allowlist before the request is built. This is also the ONLY argument
   * permitted to be an object: `interpolateBody`'s structure-injection guard
   * is lifted for exactly this one, because the allowlist is what governs its
   * shape.
   */
  fieldsFrom: string;
}

export interface ToolDef {
  name: string;
  description: string;
  input: Record<string, unknown>;
  request?: RequestDef;
  list?: ListDef;
  write?: WriteDef;
  audit?: { redact?: string[] };
}

export type AuthDef = OAuthAuthDef | NoAuthDef;

/**
 * An upstream that needs no credential at all: a public API, or one whose
 * key travels as a plain header declared in `requestHeaders`. Explicit rather
 * than an absent `auth` block, so a config that forgot its auth reads as a
 * build failure instead of an unauthenticated app.
 */
export interface NoAuthDef {
  type: "none";
}

export interface OAuthAuthDef {
  /**
   * Which OAuth 2 grant mints the upstream token. `lib/adapters/auth.ts`
   * maps this to the `grant_type` body parameter; every other secret in
   * `secrets` is sent under its own name, so a refresh-token app simply
   * declares a third secret (`refresh_token`) alongside client_id/secret.
   */
  type: "oauth2_client_credentials" | "oauth2_refresh_token";
  tokenUrl: string;
  bodyFormat: "json" | "form";
  secrets: Record<string, string>;
  expiry: { field: string; coerce: "number"; skewSeconds: number };
}

export interface TransportDef {
  minIntervalMs: number;
  timeoutMs: number;
  retry: { attempts: number; on: string[]; respectRetryAfter: boolean };
  errors: { format: "json" | "html" };
  /**
   * Response headers carrying the upstream's own quota, for an upstream that reports one.
   * `resetHeader` is the number of seconds until the window resets (a countdown, not a
   * timestamp). When `remainingHeader` reaches 0, the client holds every call until the
   * reset instead of spending requests on 429s, and a 429 with no Retry-After waits out
   * the reset rather than the short exponential backoff. Declare it only for headers you
   * have watched an upstream send: Service Fusion does; FieldEdge and CMap send none.
   */
  rateLimit?: { remainingHeader: string; resetHeader: string };
}

export interface AppConfig {
  app: string;
  displayName: string;
  baseUrl: string;
  auth: AuthDef;
  transport: TransportDef;
  tools: ToolDef[];
  /**
   * Static headers added to every upstream API request, resolved from Vault
   * at call time. Maps header name → Vault secret path. Useful for APIs that
   * require a tenant or account identifier header separate from the bearer
   * token (e.g. CMap's `tenant_id`).
   */
  requestHeaders?: Record<string, string>;
}

export interface RoleDef {
  tools: string[];
  /** Response field allowlists, per tool pattern. Deny-by-default. */
  fields: Record<string, { allow: string[] }>;
  /**
   * REQUEST-body field allowlists for write tools, per tool pattern. A
   * separate vocabulary from `fields` on purpose: without it, "can read
   * deals" and "can edit deals" would be the same grant, since `tools` only
   * controls reachability. Deny-by-default and, unlike `fields`, wildcards
   * are rejected outright — a wildcard read exposes a field, a wildcard write
   * lets a caller overwrite one nobody reviewed, so every writable field must
   * be named. A role granting a write tool with no matching `writes` entry
   * fails the build rather than silently granting a tool that can write
   * nothing.
   */
  writes?: Record<string, { allow: string[] }>;
}

export interface RolesConfig {
  roles: Record<string, RoleDef>;
}

/** One app within one org, as loaded from git at boot. */
export interface AppEntry {
  org: string;
  app: string;
  config: AppConfig;
  roles: RolesConfig;
}

export interface Principal {
  userId: string;
  orgId: string;
  orgSlug: string;
  roles: string[];
  /**
   * Exact RFC 8707 resource authorized for an OAuth token. Manual API keys
   * carry null and remain org-wide; OAuth tokens must match the request's
   * canonical org/app resource exactly.
   */
  oauthResource: string | null;
}

/**
 * Resolved access for one principal: exposed tool names, and per-tool field
 * allowlists. A plausible thing to cache, so each allowlist is a frozen,
 * read-only array — a consumer mutating it in place (e.g. `.sort()`) must
 * not be able to silently rewrite policy shared with other callers.
 */
export interface Grant {
  tools: Set<string>;
  fields: Map<string, readonly string[]>;
  /** Writable request-body fields per tool, unioned across the caller's roles. */
  writes: Map<string, readonly string[]>;
  unknownRoles: string[];
}
