import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateApiKey } from "@/lib/auth/api-key";

export interface KeySummary {
  id: string;
  prefix: string;
  label: string | null;
  source: "manual" | "oauth";
  userEmail: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Resolves a set of user ids to emails through `supabase.auth.admin.listUsers`
 * — supabase-js has no admin get-by-id-list (or get-by-email) call, so this
 * pages the whole user list once and looks up locally. Same constraint and
 * same 1000-row page size as `lib/admin/members.ts`'s `listMembers`: neither
 * is expected to matter until an org has a genuinely large membership.
 */
async function emailsByUserId(supabase: AdminClient): Promise<Map<string, string | null>> {
  const { data: page, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (error) {
    throw new Error(`emailsByUserId: error listing auth users: ${error.message}`);
  }
  return new Map(
    (page?.users ?? []).map((u: { id: string; email?: string }) => [u.id, u.email ?? null]),
  );
}

/**
 * Live (non-revoked) API keys for an org — manually issued `kngw_` keys and
 * phase 2 OAuth-issued tokens both live in `api_keys` (`source` tells them
 * apart), so both show up here. A revoked row is never returned: revocation
 * is a soft delete (`revoked_at`), not a row disappearing from the table,
 * but this list is "what can currently authenticate," not "everything ever
 * issued."
 */
export async function listKeys(orgId: string): Promise<KeySummary[]> {
  const supabase = createAdminClient();

  const { data: rows, error } = await supabase
    .from("api_keys")
    .select("id, prefix, label, source, user_id, created_at, last_used_at")
    .eq("org_id", orgId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`listKeys: error listing api keys for org "${orgId}": ${error.message}`);
  }

  const emails = await emailsByUserId(supabase);

  return (
    (rows ?? []) as Array<{
      id: string;
      prefix: string;
      label: string | null;
      source: "manual" | "oauth";
      user_id: string;
      created_at: string;
      last_used_at: string | null;
    }>
  ).map((row) => ({
    id: row.id,
    prefix: row.prefix,
    label: row.label,
    source: row.source,
    userEmail: emails.get(row.user_id) ?? null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

/**
 * Mints a new manual API key via `generateApiKey` (`lib/auth/api-key.ts`) —
 * never reimplemented here — and stores only its `prefix` and `hash`. The
 * full key is returned to the caller in this one return value; it is never
 * written to `api_keys`, never logged, and never passed to
 * `writeAdminAudit`. The caller (the keys page's Server Action) is
 * responsible for rendering it exactly once and discarding it.
 */
export async function issueKey(input: {
  orgId: string;
  orgSlug: string;
  userId: string;
  label: string;
}): Promise<{ key: string; prefix: string }> {
  const { key, prefix, hash } = generateApiKey(input.orgSlug);

  const supabase = createAdminClient();
  const { error } = await supabase.from("api_keys").insert({
    org_id: input.orgId,
    user_id: input.userId,
    prefix,
    hash,
    label: input.label,
  });
  if (error) {
    throw new Error(
      `issueKey: error inserting api key for org "${input.orgId}": ${error.message}`,
    );
  }

  return { key, prefix };
}

/**
 * Revokes a key by setting `revoked_at` — never by deleting the row.
 * Revocation must stay auditable, and phase 2 OAuth tokens live in this same
 * table, so a delete here would be indistinguishable from destroying
 * evidence of either. Filters on BOTH `id` and `org_id` so one org's admin
 * cannot revoke another org's key by guessing (or brute-forcing) an id.
 */
export async function revokeKey(orgId: string, keyId: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", keyId)
    .eq("org_id", orgId);
  if (error) {
    throw new Error(
      `revokeKey: error revoking key "${keyId}" in org "${orgId}": ${error.message}`,
    );
  }
}
