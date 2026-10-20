import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/** Read only the signed-in user's own data-role assignments, grouped by org. */
export async function viewerRolesByOrg(
  userId: string,
  orgIds: string[],
): Promise<Map<string, string[]>> {
  if (orgIds.length === 0) return new Map();

  const { data, error } = await createAdminClient()
    .from("role_assignments")
    .select("org_id, role")
    .eq("user_id", userId)
    .in("org_id", orgIds);
  if (error) throw new Error(`viewerRolesByOrg: failed to load roles: ${error.message}`);

  const roles = new Map<string, string[]>();
  for (const row of (data ?? []) as Array<{ org_id: string; role: string }>) {
    const current = roles.get(row.org_id) ?? [];
    current.push(row.role);
    roles.set(row.org_id, current);
  }
  for (const current of roles.values()) current.sort();
  return roles;
}
