-- supabase/migrations/20260913000000_audit_unknown_roles.sql
--
-- S3 (Task 12 final review): a stale or typo'd `role_assignments.role` row already fails
-- closed at request time (an unknown role is simply inert — see lib/policy/grants.ts's
-- `computeGrant`), but until now that fact left no trace anywhere a support engineer or org
-- admin could see it. `lib/mcp/handler.ts` now threads `Grant.unknownRoles` into every audit
-- row it writes for a request; this column is where that lands.
--
-- Table-level grants already given to `service_role` on `public.audit_events` in
-- 20260912000000_gateway_core.sql cover this new column too (Postgres table-level GRANTs are
-- not per-column), so nothing further is needed there.

alter table public.audit_events add column unknown_roles text[];

comment on column public.audit_events.unknown_roles is
  'Roles this principal was assigned in role_assignments that do not exist in the app''s committed roles.json at request time — a stale/typo''d role assignment, surfaced for support/admin diagnosis.';
