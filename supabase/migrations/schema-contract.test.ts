import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// This test does not execute the migration -- there is no local Postgres in
// this environment (see task-5-report.md for why). It instead asserts the
// schema contract that later tasks depend on by exact column name, so a
// renamed/dropped column or a resurrected foreign key on `role_assignments.role`
// fails here instead of silently at deploy.

const migrationPath = fileURLToPath(
  new URL("./20260912000000_gateway_core.sql", import.meta.url)
);

const rawSql = readFileSync(migrationPath, "utf-8");

const oauthMigrationPath = fileURLToPath(
  new URL("./20260913020000_oauth.sql", import.meta.url)
);

const rawOauthSql = readFileSync(oauthMigrationPath, "utf-8");

// Strip `--` line comments before collapsing whitespace. A line comment only
// runs to the end of its line in real SQL; once newlines are gone, an
// un-stripped comment (e.g. one containing a comma, like "-- sha256 of the
// full key") would keep running and swallow the next column definition(s)
// into itself. This does not touch the `comment on table ... is '...'` SQL
// statement used for the retention note below, which is a distinct syntax.
const withoutLineComments = rawSql.replace(/--[^\n]*/g, "");

// Collapse all runs of whitespace (including newlines) to a single space so
// that formatting changes (re-indenting, re-wrapping a line) can never break
// a match that depends on adjacency between tokens.
const sql = withoutLineComments.replace(/\s+/g, " ").trim();

// Same treatment for the phase 2 OAuth migration -- kept as its own variable
// (rather than concatenated onto `sql`) so a `tableBody` lookup against one
// migration can never accidentally match a same-named table declared in the
// other.
const withoutOauthLineComments = rawOauthSql.replace(/--[^\n]*/g, "");
const oauthSql = withoutOauthLineComments.replace(/\s+/g, " ").trim();

/**
 * Splits a comma-separated list on top-level commas only, ignoring commas
 * nested inside parentheses (e.g. inside a `primary key (a, b)` clause or a
 * `references foo(id)` clause). Used to isolate one column definition from
 * the table body without it bleeding into neighboring definitions.
 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(body.slice(start).trim());
  return parts;
}

/**
 * Extracts the parenthesized body of `create table public.<name> ( ... )`
 * by matching balanced parens, so nested `references foo(id)` and
 * `primary key (a, b)` clauses don't confuse a naive "find the closing
 * paren" search.
 */
function tableBody(text: string, name: string): string {
  const marker = `create table public.${name} (`;
  const markerStart = text.indexOf(marker);
  if (markerStart === -1) {
    throw new Error(`could not find "create table public.${name} (" in migration SQL`);
  }
  const openParenIndex = markerStart + marker.length - 1;
  let depth = 0;
  let bodyStart = -1;
  for (let i = openParenIndex; i < text.length; i++) {
    if (text[i] === "(") {
      depth++;
      if (depth === 1) bodyStart = i + 1;
    } else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(bodyStart, i);
    }
  }
  throw new Error(`unbalanced parentheses in table ${name}`);
}

function columnDef(body: string, columnName: string): string {
  const parts = splitTopLevel(body);
  const match = parts.find((part) => new RegExp(`^${columnName}\\b`).test(part));
  if (!match) {
    throw new Error(`column "${columnName}" not found in table body`);
  }
  return match;
}

const TABLES = [
  "organizations",
  "memberships",
  "role_assignments",
  "api_keys",
  "audit_events",
] as const;

describe("gateway_core migration: table presence", () => {
  it.each(TABLES)("creates table public.%s", (name) => {
    expect(() => tableBody(sql, name)).not.toThrow();
  });
});

describe("gateway_core migration: api_keys contract (Task 6 key lookup)", () => {
  const body = tableBody(sql, "api_keys");

  it("has a unique prefix column used for lookup", () => {
    const def = columnDef(body, "prefix");
    expect(def).toMatch(/^prefix\s+text\s+not\s+null\s+unique\b/);
  });

  it("has a hash column", () => {
    const def = columnDef(body, "hash");
    expect(def).toMatch(/^hash\s+text\s+not\s+null\b/);
  });

  it("has an org_id column referencing organizations", () => {
    const def = columnDef(body, "org_id");
    expect(def).toMatch(/^org_id\s+uuid\s+not\s+null\s+references\s+public\.organizations\(id\)/);
  });

  it("has a user_id column referencing auth.users", () => {
    const def = columnDef(body, "user_id");
    expect(def).toMatch(/^user_id\s+uuid\s+not\s+null\s+references\s+auth\.users\(id\)/);
  });

  it("has a revoked_at column", () => {
    const def = columnDef(body, "revoked_at");
    expect(def).toMatch(/^revoked_at\s+timestamptz\b/);
  });
});

describe("gateway_core migration: organizations contract (Task 6 slug resolution)", () => {
  it("has a slug column", () => {
    const body = tableBody(sql, "organizations");
    const def = columnDef(body, "slug");
    expect(def).toMatch(/^slug\s+text\s+not\s+null\s+unique\b/);
  });
});

describe("gateway_core migration: role_assignments contract (Task 6 role lookup)", () => {
  const body = tableBody(sql, "role_assignments");

  it("has user_id, org_id, and role columns", () => {
    expect(columnDef(body, "user_id")).toMatch(/^user_id\s+uuid\s+not\s+null\s+references\s+auth\.users\(id\)/);
    expect(columnDef(body, "org_id")).toMatch(/^org_id\s+uuid\s+not\s+null\s+references\s+public\.organizations\(id\)/);
    expect(columnDef(body, "role")).toMatch(/^role\s+text\s+not\s+null\b/);
  });

  it("does NOT declare role as a foreign key (inline column form) -- role definitions live in git, and a stale row must be inert rather than a constraint violation", () => {
    const def = columnDef(body, "role");
    expect(def).not.toMatch(/references/i);
  });

  it("does NOT declare role as a foreign key (table-level constraint form) -- a `foreign key (role) references ...` constraint added elsewhere in the table, or by a later `alter table ... add constraint`, would reintroduce the same failure mode and is invisible to columnDef, which only inspects parts that begin with the column name", () => {
    expect(sql).not.toMatch(/foreign key\s*\(\s*role\s*\)/i);
  });
});

describe("gateway_core migration: audit_events contract (Task 10 insert)", () => {
  const body = tableBody(sql, "audit_events");

  it("uses an identity column for id, not bigserial -- bigserial's implicit sequence needs a USAGE grant this migration does not give (service_role's BYPASSRLS does not cover ordinary sequence privileges), while an identity column's sequence is owned by the column and needs none", () => {
    const def = columnDef(body, "id");
    expect(def).toMatch(/^id\s+bigint\s+generated\s+always\s+as\s+identity\s+primary\s+key\b/);
    expect(def).not.toMatch(/bigserial/i);
  });

  const expectedColumns: Record<string, RegExp> = {
    org_id: /^org_id\s+uuid\s+references\s+public\.organizations\(id\)/,
    user_id: /^user_id\s+uuid\s+references\s+auth\.users\(id\)/,
    principal_kind: /^principal_kind\s+text\s+not\s+null\b/,
    app: /^app\s+text\b/,
    tool: /^tool\s+text\b/,
    decision: /^decision\s+text\s+not\s+null\b/,
    args: /^args\s+jsonb\b/,
    result_count: /^result_count\s+integer\b/,
    upstream_status: /^upstream_status\s+integer\b/,
    duration_ms: /^duration_ms\s+integer\b/,
    error: /^error\s+text\b/,
  };

  it.each(Object.entries(expectedColumns))("has column %s with the expected type", (column, pattern) => {
    expect(columnDef(body, column)).toMatch(pattern);
  });
});

describe("gateway_core migration: row level security and grants", () => {
  it.each(TABLES)("enables row level security on public.%s", (name) => {
    const pattern = new RegExp(`alter table public\\.${name}\\s+enable row level security`);
    expect(sql).toMatch(pattern);
  });

  it.each(TABLES)("grants service_role full access on public.%s", (name) => {
    const pattern = new RegExp(
      `grant select, insert, update, delete on public\\.${name}\\s+to service_role`
    );
    expect(sql).toMatch(pattern);
  });
});

describe("gateway_core migration: audit_events retention", () => {
  it("documents the 90-day retention window in a table comment", () => {
    expect(sql).toMatch(
      /comment on table public\.audit_events is 'Retention: 90 days\./
    );
  });

  it("indexes ts alone -- the 90-day purge filters on ts, the non-leading column of audit_events_org_ts_idx (org_id, ts), so without a dedicated index the purge scans the highest-volume table in the schema", () => {
    expect(sql).toMatch(
      /create index audit_events_ts_idx on public\.audit_events \(ts\)/
    );
  });

  it("guards against `--` line-comment stripping truncating a real SQL string literal -- the retention comment is a `comment on table ... is '...'` statement, not a `--` line comment, so stripping `--...` before this must leave the full literal, including its closing quote and semicolon, intact", () => {
    expect(sql).toMatch(
      /comment on table public\.audit_events is 'Retention: 90 days\. Contains customer PII in args\.';/
    );
  });
});

const OAUTH_TABLES = ["oauth_clients", "oauth_authorization_codes"] as const;

describe("oauth migration: table presence", () => {
  it.each(OAUTH_TABLES)("creates table public.%s", (name) => {
    expect(() => tableBody(oauthSql, name)).not.toThrow();
  });
});

describe("oauth migration: row level security", () => {
  it.each(OAUTH_TABLES)("enables row level security on public.%s", (name) => {
    const pattern = new RegExp(`alter table public\\.${name}\\s+enable row level security`);
    expect(oauthSql).toMatch(pattern);
  });
});

describe("oauth migration: oauth_authorization_codes contract (org binding)", () => {
  it("has an org_id column that is not null -- the org this code was consented for, resolved from the RFC 8707 `resource` parameter at consent time and carried into the issued token", () => {
    const body = tableBody(oauthSql, "oauth_authorization_codes");
    const def = columnDef(body, "org_id");
    expect(def).toMatch(/^org_id\s+uuid\s+not\s+null\s+references\s+public\.organizations\(id\)/);
  });
});

describe("oauth migration: api_keys gains the OAuth columns", () => {
  it("adds source, defaulting to 'manual', constrained to ('manual', 'oauth')", () => {
    expect(oauthSql).toMatch(
      /alter table public\.api_keys add column source text not null default 'manual' check \(source in \('manual', 'oauth'\)\)/
    );
  });

  it("adds oauth_client_id referencing oauth_clients", () => {
    expect(oauthSql).toMatch(
      /add column oauth_client_id text references public\.oauth_clients\(client_id\) on delete set null/
    );
  });

  it("adds expires_at -- NULL means a manual key that never expires; lib/auth/api-key.ts treats a non-null-but-unparseable value as expired", () => {
    expect(oauthSql).toMatch(/add column expires_at timestamptz/);
  });

  it("adds refresh_token_hash", () => {
    expect(oauthSql).toMatch(/add column refresh_token_hash text/);
  });

  it("adds refresh_token_prefix", () => {
    expect(oauthSql).toMatch(/add column refresh_token_prefix text/);
  });

  it("adds scopes, defaulting to an empty array", () => {
    expect(oauthSql).toMatch(/add column scopes text\[\] not null default '\{\}'/);
  });
});

describe("oauth migration: no GRANT to authenticated or anon (spec decision 8)", () => {
  it("never grants authenticated or anon on any table in this migration -- every table here is service-role only behind RLS, a deliberate deviation from the standing cross-project convention, documented in the migration's own header comment", () => {
    expect(oauthSql).not.toMatch(/grant\s+[^;]*\bto\s+(authenticated|anon)\b/i);
  });
});

// Phase 3: admin console. Kept as its own variable for the same reason the
// OAuth migration is -- a `tableBody`/`grant` assertion against one migration
// must never accidentally match a same-named table or grant declared in
// another.
const adminMigrationPath = fileURLToPath(
  new URL("./20260914000000_admin_console.sql", import.meta.url)
);
const rawAdminSql = readFileSync(adminMigrationPath, "utf-8");
const withoutAdminLineComments = rawAdminSql.replace(/--[^\n]*/g, "");
const adminSql = withoutAdminLineComments.replace(/\s+/g, " ").trim();

const invariantMigrationPath = fileURLToPath(
  new URL("./20260919000000_resource_binding_and_admin_invariants.sql", import.meta.url)
);
const rawInvariantSql = readFileSync(invariantMigrationPath, "utf-8");
const invariantSql = rawInvariantSql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();

describe("admin console migration", () => {
  it("adds admin_role to memberships, constrained to the two platform roles", () => {
    expect(adminSql).toMatch(/alter table public\.memberships/);
    expect(adminSql).toMatch(/add column admin_role text not null default 'member'/);
    expect(adminSql).toMatch(/check \(admin_role in \('org_admin', 'member'\)\)/);
  });

  it("records who invited a member and when", () => {
    expect(adminSql).toMatch(/add column invited_by uuid references auth\.users\(id\) on delete set null/);
    expect(adminSql).toMatch(/add column invited_at timestamptz/);
  });

  it("keeps super admin in its own table with a grant trail", () => {
    const body = tableBody(adminSql, "platform_admins");
    expect(body).toMatch(/user_id uuid primary key references auth\.users\(id\) on delete cascade/);
    expect(body).toMatch(/granted_by uuid references auth\.users\(id\) on delete set null/);
    expect(body).toMatch(/granted_at timestamptz not null default now\(\)/);
  });

  it("audits admin actions in a separate table from tool-call audit_events", () => {
    const body = tableBody(adminSql, "admin_audit_events");
    expect(body).toMatch(/actor_user_id uuid references auth\.users\(id\) on delete set null/);
    expect(body).toMatch(/actor_was_super boolean not null default false/);
    // Nullable: org.create and superadmin.grant have no org.
    expect(body).toMatch(/org_id uuid references public\.organizations\(id\) on delete set null/);
    expect(body).toMatch(/action text not null/);
    expect(body).toMatch(/outcome text not null check \(outcome in \('ok', 'denied', 'error'\)\)/);
  });

  it("never grants the new tables to authenticated or anon", () => {
    expect(adminSql).not.toMatch(/grant[^;]*\bto\b[^;]*\bauthenticated\b/);
    expect(adminSql).not.toMatch(/grant[^;]*\bto\b[^;]*\banon\b/);
    expect(adminSql).toMatch(/grant select, insert, update, delete on public\.platform_admins to service_role/);
    expect(adminSql).toMatch(/grant select, insert, update, delete on public\.admin_audit_events to service_role/);
  });

  it("enables RLS on both new tables", () => {
    expect(adminSql).toMatch(/alter table public\.platform_admins enable row level security/);
    expect(adminSql).toMatch(/alter table public\.admin_audit_events enable row level security/);
  });

  it("locks write_vault_secret down the same way read_vault_secret is", () => {
    expect(adminSql).toMatch(/create or replace function public\.write_vault_secret\(p_name text, p_secret text\)/);
    expect(adminSql).toMatch(/security definer/);
    expect(adminSql).toMatch(/set search_path = ''/);
    // The revoke is the point: Postgres grants EXECUTE to PUBLIC by default.
    expect(adminSql).toMatch(/revoke all on function public\.write_vault_secret\(text, text\) from public/);
    expect(adminSql).toMatch(/revoke all on function public\.write_vault_secret\(text, text\) from anon, authenticated/);
    expect(adminSql).toMatch(/grant execute on function public\.write_vault_secret\(text, text\) to service_role/);
  });
});

describe("resource binding and atomic admin invariants migration", () => {
  it("adds an OAuth resource audience and revokes unbound live OAuth credentials", () => {
    expect(invariantSql).toMatch(/alter table public\.api_keys add column oauth_resource text/);
    expect(invariantSql).toMatch(/update public\.api_keys set revoked_at = now\(\) where source = 'oauth' and revoked_at is null/);
    expect(invariantSql).toMatch(/check \(source <> 'oauth' or oauth_resource is not null or revoked_at is not null\)/);
  });

  it("serializes demotion and removal on the same per-org transaction lock", () => {
    expect(invariantSql.match(/pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(p_org_id::text, 0\)\)/g)).toHaveLength(2);
    expect(invariantSql).toMatch(/create or replace function public\.set_membership_admin_role/);
    expect(invariantSql).toMatch(/create or replace function public\.remove_org_member/);
  });

  it("keeps both SECURITY DEFINER mutations service-role only", () => {
    expect(invariantSql).toMatch(/revoke all on function public\.set_membership_admin_role\(uuid, uuid, text\) from public/);
    expect(invariantSql).toMatch(/grant execute on function public\.set_membership_admin_role\(uuid, uuid, text\) to service_role/);
    expect(invariantSql).toMatch(/revoke all on function public\.remove_org_member\(uuid, uuid\) from public/);
    expect(invariantSql).toMatch(/grant execute on function public\.remove_org_member\(uuid, uuid\) to service_role/);
  });
});
