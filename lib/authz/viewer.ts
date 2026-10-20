import "server-only";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type AdminRole = "org_admin" | "member";

export interface ViewerOrg {
  id: string;
  slug: string;
  name: string;
  adminRole: AdminRole;
}

export interface Viewer {
  userId: string;
  email: string | null;
  isSuperAdmin: boolean;
  orgs: ViewerOrg[];
}

/**
 * Resolves who is signed in (via the cookie-session client) and what
 * platform-role standing they have (via the service-role client). This is
 * the only place either half of that resolution happens — `role_assignments`
 * (data-access roles: `field_tech`, `bookkeeper`, `owner`, ...) is never read
 * or written here; this file deals exclusively with the platform roles
 * `super_admin` / `org_admin` / `member`.
 */
export async function getViewer(): Promise<Viewer | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const admin = createAdminClient();

  const { data: superAdminRow } = await admin
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const { data: membershipRows, error: membershipError } = await admin
    .from("memberships")
    .select("admin_role, organizations(id, slug, name)")
    .eq("user_id", user.id);

  if (membershipError) {
    throw new Error(`getViewer: failed to load memberships: ${membershipError.message}`);
  }

  // `organizations(id, slug, name)` is an embed across the `org_id` FK. The
  // admin client has no generated Database type here, so supabase-js infers
  // the embed generically as an array; it is genuinely a single row (`org_id`
  // is a NOT NULL FK to `organizations.id`). Same cast pattern as
  // `lib/oauth/tokens.ts`'s `rotateRefreshToken`.
  const rows = (membershipRows ?? []) as unknown as Array<{
    admin_role: AdminRole;
    organizations: { id: string; slug: string; name: string };
  }>;

  const orgs: ViewerOrg[] = rows.map((row) => ({
    id: row.organizations.id,
    slug: row.organizations.slug,
    name: row.organizations.name,
    adminRole: row.admin_role,
  }));

  return {
    userId: user.id,
    email: user.email ?? null,
    isSuperAdmin: Boolean(superAdminRow),
    orgs,
  };
}

/** Resolves a viewer or redirects to `/login` — never returns null. */
async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  return viewer;
}

export async function requireSuperAdmin(): Promise<Viewer> {
  const viewer = await requireViewer();
  if (!viewer.isSuperAdmin) redirect("/admin?error=forbidden");
  return viewer;
}

/**
 * Resolves an org straight from `organizations` by slug, for the super-admin
 * path where the viewer may have no `memberships` row for it at all.
 */
async function resolveOrgBySlug(slug: string): Promise<ViewerOrg | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("id, slug, name")
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    throw new Error(`resolveOrgBySlug: failed to load organization: ${error.message}`);
  }
  if (!data) return null;

  return { id: data.id, slug: data.slug, name: data.name, adminRole: "org_admin" };
}

/**
 * Super admin status is checked FIRST — a super admin passes for any org,
 * including one they hold no `memberships` row for at all, resolved directly
 * from `organizations`. Only once that check is out of the way does this
 * fall back to the viewer's own membership row and its `admin_role`.
 */
export async function requireOrgAdmin(
  slug: string,
): Promise<{ viewer: Viewer; org: ViewerOrg }> {
  const viewer = await requireViewer();

  if (viewer.isSuperAdmin) {
    const org = await resolveOrgBySlug(slug);
    if (!org) redirect("/admin?error=forbidden");
    return { viewer, org };
  }

  const org = viewer.orgs.find((o) => o.slug === slug);
  if (!org || org.adminRole !== "org_admin") redirect("/admin?error=forbidden");
  return { viewer, org };
}

/**
 * Same super-admin-first resolution as `requireOrgAdmin`, but any membership
 * (not only `org_admin`) is sufficient for a non-super-admin viewer.
 */
export async function requireOrgMember(
  slug: string,
): Promise<{ viewer: Viewer; org: ViewerOrg }> {
  const viewer = await requireViewer();

  if (viewer.isSuperAdmin) {
    const org = await resolveOrgBySlug(slug);
    if (!org) redirect("/admin?error=forbidden");
    return { viewer, org };
  }

  const org = viewer.orgs.find((o) => o.slug === slug);
  if (!org) redirect("/admin?error=forbidden");
  return { viewer, org };
}
