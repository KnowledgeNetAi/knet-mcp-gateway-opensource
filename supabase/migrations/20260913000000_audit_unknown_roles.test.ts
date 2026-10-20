import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Same rationale as schema-contract.test.ts: no local Postgres in this environment, so this
// asserts the migration's text contract by exact column name rather than executing it.

const migrationPath = fileURLToPath(
  new URL("./20260913000000_audit_unknown_roles.sql", import.meta.url),
);
const sql = readFileSync(migrationPath, "utf-8").replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();

describe("audit_unknown_roles migration (S3, Task 12 final review)", () => {
  it("adds an unknown_roles text[] column to public.audit_events", () => {
    expect(sql).toMatch(/alter table public\.audit_events add column unknown_roles text\[\]/);
  });

  it("does not create any new table (only alters the existing one, so the CLAUDE.md new-public-table GRANT convention does not apply here)", () => {
    expect(sql).not.toMatch(/create table/i);
  });
});
