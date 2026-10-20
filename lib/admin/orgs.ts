import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCatalog } from "@/lib/mcp/catalog";
import { isValidOrgSlug, ORG_SLUG_CHARS } from "@/lib/policy/slug";

export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  /** From the git catalog (`getCatalog()`), never the database — spec decision 4. */
  appCount: number;
  memberCount: number;
  activeKeyCount: number;
}

/**
 * `reason` is a closed union so a caller (Server Action) can branch on it
 * without string-matching `.message`:
 *   - "bad_slug": the slug contains characters outside `ORG_SLUG_CHARS`. Every
 *     API key minted for the org embeds the slug in its `kngw_<slug>_<hex>`
 *     prefix (`lib/auth/api-key.ts`'s `generateApiKey`/`parseKey`), so a slug
 *     outside that charset would mint keys that can never authenticate.
 *   - "slug_taken": a unique-violation (Postgres `23505`) on insert.
 *   - "db_error": any other database failure.
 */
export class OrgError extends Error {
  constructor(
    public readonly reason: "bad_slug" | "slug_taken" | "db_error",
    message: string,
  ) {
    super(message);
    this.name = "OrgError";
  }
}

/** appCount per org slug, from the git catalog — never the database. */
function appCountsBySlug(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of getCatalog().values()) {
    counts.set(entry.org, (counts.get(entry.org) ?? 0) + 1);
  }
  return counts;
}

/**
 * Every organization in the database, with member/key counts from the
 * database and an app count from the git catalog. Used by the super-admin
 * "all organizations" list — a small, pilot-scale table, so this reads the
 * three source tables in full rather than paginating.
 */
export async function listAllOrgs(): Promise<OrgSummary[]> {
  const supabase = createAdminClient();

  const { data: orgRows, error: orgErr } = await supabase
    .from("organizations")
    .select("id, slug, name");
  if (orgErr) {
    throw new OrgError("db_error", `error listing organizations: ${orgErr.message}`);
  }

  const { data: memberRows, error: memberErr } = await supabase
    .from("memberships")
    .select("org_id");
  if (memberErr) {
    throw new OrgError("db_error", `error counting members: ${memberErr.message}`);
  }
  const memberCounts = new Map<string, number>();
  for (const row of (memberRows ?? []) as Array<{ org_id: string }>) {
    memberCounts.set(row.org_id, (memberCounts.get(row.org_id) ?? 0) + 1);
  }

  const { data: keyRows, error: keyErr } = await supabase
    .from("api_keys")
    .select("org_id")
    .is("revoked_at", null);
  if (keyErr) {
    throw new OrgError("db_error", `error counting active keys: ${keyErr.message}`);
  }
  const keyCounts = new Map<string, number>();
  for (const row of (keyRows ?? []) as Array<{ org_id: string }>) {
    keyCounts.set(row.org_id, (keyCounts.get(row.org_id) ?? 0) + 1);
  }

  const appCounts = appCountsBySlug();

  return ((orgRows ?? []) as Array<{ id: string; slug: string; name: string }>).map((org) => ({
    id: org.id,
    slug: org.slug,
    name: org.name,
    appCount: appCounts.get(org.slug) ?? 0,
    memberCount: memberCounts.get(org.id) ?? 0,
    activeKeyCount: keyCounts.get(org.id) ?? 0,
  }));
}

/**
 * One organization's overview: DB-backed summary counts plus its apps, read
 * straight from `getCatalog()` — **not** the database (spec decision 4). An
 * org with no committed `orgs/<slug>/<app>/` config legitimately has zero
 * apps; that is not an error.
 *
 * Callers reach this only after `requireOrgMember`/`requireOrgAdmin` has
 * already confirmed the org exists, so a missing row here means the org was
 * deleted out from under the request — reported as `db_error` since there is
 * no dedicated "not found" reason in this module's error union.
 */
export async function orgOverview(
  slug: string,
): Promise<
  OrgSummary & { apps: Array<{ app: string; displayName: string; toolCount: number; roles: string[] }> }
> {
  const supabase = createAdminClient();

  const { data: orgRow, error: orgErr } = await supabase
    .from("organizations")
    .select("id, slug, name")
    .eq("slug", slug)
    .maybeSingle();
  if (orgErr) {
    throw new OrgError("db_error", `error looking up org "${slug}": ${orgErr.message}`);
  }
  if (!orgRow) {
    throw new OrgError("db_error", `no organization with slug "${slug}"`);
  }
  const org = orgRow as { id: string; slug: string; name: string };

  const { data: memberRows, error: memberErr } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("org_id", org.id);
  if (memberErr) {
    throw new OrgError("db_error", `error counting members for org "${slug}": ${memberErr.message}`);
  }

  const { data: keyRows, error: keyErr } = await supabase
    .from("api_keys")
    .select("id")
    .eq("org_id", org.id)
    .is("revoked_at", null);
  if (keyErr) {
    throw new OrgError(
      "db_error",
      `error counting active keys for org "${slug}": ${keyErr.message}`,
    );
  }

  const apps = [...getCatalog().values()]
    .filter((entry) => entry.org === slug)
    .map((entry) => ({
      app: entry.app,
      displayName: entry.config.displayName,
      toolCount: entry.config.tools.length,
      roles: Object.keys(entry.roles.roles).sort(),
    }))
    .sort((a, b) => a.app.localeCompare(b.app));

  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    appCount: apps.length,
    memberCount: (memberRows ?? []).length,
    activeKeyCount: (keyRows ?? []).length,
    apps,
  };
}

/**
 * Creates an organization shell. Its apps live in git, not here — this only
 * writes the `organizations` row that `memberships`/`api_keys`/`role_assignments`
 * hang off of.
 */
export async function createOrg(input: { slug: string; name: string }): Promise<{ id: string }> {
  const { slug, name } = input;

  if (!isValidOrgSlug(slug)) {
    throw new OrgError(
      "bad_slug",
      `org slug ${JSON.stringify(slug)} contains characters outside [${ORG_SLUG_CHARS}]`,
    );
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("organizations")
    .insert({ slug, name })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new OrgError("slug_taken", `an organization with slug "${slug}" already exists`);
    }
    throw new OrgError("db_error", `error creating organization "${slug}": ${error.message}`);
  }

  return { id: (data as { id: string }).id };
}
