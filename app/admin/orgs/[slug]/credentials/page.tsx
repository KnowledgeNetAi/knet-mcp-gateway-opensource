import { requireOrgAdmin } from "@/lib/authz/viewer";
import { credentialFieldsFor, type CredentialField } from "@/lib/admin/credentials";
import { AdminFrame, AdminPanel, AdminSubmit, AdminNotice } from "@/components/admin/frame";
import { AdminTable } from "@/components/admin/table";
import { OrgNav } from "@/components/admin/org-nav";
import { writeCredentialAction, testConnectionAction } from "./actions";

type Params = Promise<{ slug: string }>;
type SearchParams = Promise<{
  saved?: string;
  error?: string;
  tested?: string;
  ok?: string;
  detail?: string;
}>;

const ERRORS: Record<string, { label: string; detail: string }> = {
  empty_value: {
    label: "Value required",
    detail: "Enter a value before saving.",
  },
  cross_org: {
    label: "Not permitted",
    detail: "That field does not belong to this organization.",
  },
  write_failed: {
    label: "Something went wrong",
    detail: "The credential was not saved. Try again.",
  },
};

/**
 * "Set · updated <date>" or "Not set" — decision 8 (never render a stored
 * credential back, not masked, not behind a reveal). `field.updatedAt` is
 * `null` whenever the secret predates this console or was seeded outside
 * it (see `lib/admin/credentials.ts`); that renders as "Set" with no date
 * rather than a fabricated one.
 */
function fieldStatus(field: CredentialField): string {
  if (!field.isSet) return "Not set";
  if (!field.updatedAt) return "Set";
  const date = new Date(field.updatedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `Set · updated ${date}`;
}

function groupByApp(fields: CredentialField[]): Array<[string, CredentialField[]]> {
  const byApp = new Map<string, CredentialField[]>();
  for (const field of fields) {
    const list = byApp.get(field.app);
    if (list) list.push(field);
    else byApp.set(field.app, [field]);
  }
  return [...byApp.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Every non-HTTP-status detail `testConnection` can report. */
const KNOWN_TEST_DETAILS = new Set(["connection failed", "no such app", "this app has no upstream credential"]);

/**
 * `/admin/orgs/[slug]/credentials`. `requireOrgAdmin` gates the page render;
 * both Server Actions in `./actions.ts` perform the identical check again on
 * their own (Global Constraints — a Server Action is a public POST
 * endpoint).
 *
 * The form is generated entirely from `credentialFieldsFor`, which itself
 * reads only committed `api.json` (`auth.secrets`) plus presence/timestamp
 * metadata — nothing about a provider's field names is hardcoded here.
 *
 * THE RULE THAT MATTERS MOST (decision 8): a stored credential value is
 * never rendered back — not masked, not behind a reveal. Every input below
 * is an empty `type="password"` field with no `value` attribute; the only
 * thing ever shown about an existing credential is `fieldStatus`'s
 * set/unset label and a timestamp.
 */
export default async function CredentialsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { slug } = await params;
  const { org } = await requireOrgAdmin(slug);
  const sp = await searchParams;
  const error = sp.error ? ERRORS[sp.error] : null;

  const fields = await credentialFieldsFor(slug);
  const apps = groupByApp(fields);

  // The notices below are driven by the query string, which anyone can put in
  // a link. Show only values this page could have produced itself, so a
  // crafted URL cannot make the console display arbitrary text.
  const saved = fields.some((f) => f.vaultName === sp.saved) ? sp.saved : undefined;
  const tested = apps.some(([app]) => app === sp.tested) ? sp.tested : undefined;
  const detail =
    sp.detail && (/^HTTP \d{3}$/.test(sp.detail) || KNOWN_TEST_DETAILS.has(sp.detail)) ? sp.detail : "connection failed";

  return (
    <AdminFrame
      eyebrow={`Organizations / ${org.slug} / Credentials`}
      title="Credentials"
      lede="Write-only. A saved value is never shown again, by anyone, in this console."
    >
      <OrgNav slug={slug} />
      {error && (
        <AdminNotice tone="error" label={error.label}>
          {error.detail}
        </AdminNotice>
      )}

      {saved && (
        <AdminNotice tone="ok" label="Saved">
          <code>{saved}</code> was updated.
        </AdminNotice>
      )}

      {tested && (
        <AdminNotice
          tone={sp.ok === "1" ? "ok" : "error"}
          label={sp.ok === "1" ? `${tested}: connection succeeded` : `${tested}: connection failed`}
        >
          {sp.ok !== "1" && detail}
        </AdminNotice>
      )}

      {apps.length === 0 ? (
        <p className="admin-empty">
          No apps configured. An app is added by committing{" "}
          <code>orgs/{org.slug}/&lt;app&gt;/api.json</code> — this org has no credentials to
          manage until one exists.
        </p>
      ) : (
        apps.map(([app, appFields]) => (
          <AdminPanel key={app}>
            <AdminTable title={app} columns={["Field", "Status", "Set new value"]}>
              {appFields.map((field) => (
                <tr key={field.vaultName}>
                  <td>
                    <span className="admin-chip">{field.key}</span>
                  </td>
                  <td>
                    <span className={`admin-badge ${field.isSet ? "admin-badge-ok" : "admin-badge-warn"}`}>{fieldStatus(field)}</span>
                  </td>
                  <td>
                    <form action={writeCredentialAction} className="admin-actions">
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="vaultName" value={field.vaultName} />
                      {/*
                        No `value` attribute, ever — this input starts and
                        stays empty regardless of whether the secret is set.
                        Submitting it blank is rejected by the action
                        (error=empty_value) rather than silently no-op'd, so
                        an admin can't mistake "I left it blank" for "I
                        cleared it."
                      */}
                      <input
                        type="password"
                        name="value"
                        placeholder="Enter new value"
                        autoComplete="off"
                      />
                      <button type="submit" className="admin-btn">
                        Save
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </AdminTable>

            <form action={testConnectionAction}>
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="app" value={app} />
              <AdminSubmit>Test connection</AdminSubmit>
            </form>
          </AdminPanel>
        ))
      )}
    </AdminFrame>
  );
}
