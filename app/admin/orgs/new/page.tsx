import { requireSuperAdmin } from "@/lib/authz/viewer";
import { createOrgAction } from "./actions";
import { AdminFrame, AdminPanel, AdminField, AdminSubmit, AdminNotice } from "@/components/admin/frame";

type SearchParams = Promise<{ error?: string }>;

const ERRORS: Record<string, { label: string; detail: string }> = {
  bad_slug: {
    label: "Invalid slug",
    detail: "Use only lowercase letters, numbers, and hyphens — this becomes part of every API key minted for the org.",
  },
  slug_taken: {
    label: "Slug already in use",
    detail: "An organization with that slug already exists. Choose a different one.",
  },
  db_error: {
    label: "Something went wrong",
    detail: "The organization was not created. Try again.",
  },
};

/**
 * `/admin/orgs/new`. Super-admin-only — checked here for the page render,
 * and again, independently, inside `createOrgAction` (Global Constraints).
 */
export default async function NewOrgPage({ searchParams }: { searchParams: SearchParams }) {
  await requireSuperAdmin();
  const sp = await searchParams;
  const error = sp.error ? ERRORS[sp.error] : null;

  return (
    <AdminFrame
      eyebrow="Organizations / New"
      title="New organization"
      lede="Creates the organization shell only. Its apps are added by committing orgs/<slug>/<app>/api.json and roles.json to git."
    >
      {error && (
        <AdminNotice tone="error" label={error.label}>
          {error.detail}
        </AdminNotice>
      )}

      <AdminPanel>
        <form action={createOrgAction} className="admin-form">
          <AdminField
            label="Slug"
            name="slug"
            required
            placeholder="acme-corp"
            hint="Lowercase letters, numbers, hyphens"
          />
          <AdminField label="Name" name="name" required placeholder="Acme Corp" />
          <AdminSubmit>Create organization</AdminSubmit>
        </form>
      </AdminPanel>
    </AdminFrame>
  );
}
