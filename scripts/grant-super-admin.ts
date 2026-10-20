/**
 * npm run grant-super-admin -- <email>
 *
 * Bootstraps the platform's first super admin (or grants the standing to an
 * additional account later). `super_admin` is a global, cross-org role kept
 * in `platform_admins` — deliberately separate from `memberships.admin_role`
 * (`org_admin`/`member`, scoped to one org) and from `role_assignments`
 * (git-defined data-access roles). This script only ever writes
 * `platform_admins`; it never touches either of those tables.
 *
 * The account must already exist — created via `npm run invite` or by
 * signing up — because supabase-js has no "create and grant" combined call
 * and this script has no organization to invite the person into. If no user
 * matches the given email, this exits 1 with a message saying so, rather
 * than creating one.
 *
 * `granted_by` is written as `null`: a script run has no acting signed-in
 * user to attribute the grant to (mirrors `invitedBy: null` in
 * `scripts/invite.ts`).
 *
 * --- Why this file registers its own module resolution hook ---
 *
 * This script runs under plain `node --experimental-transform-types`, not
 * through a bundler. Every other place this codebase's modules get loaded —
 * Next.js (webpack/turbopack) for the app itself, Vite for `vitest` — does
 * two things plain Node does not:
 *
 *   1. Resolves the tsconfig `@/*` path alias and infers the extension on
 *      omitted-extension imports (`moduleResolution: "bundler"`, used
 *      throughout this repo). Plain Node's ESM resolver has no notion of a
 *      tsconfig path alias and requires an explicit file extension.
 *   2. Resolves `import "server-only"` (which `lib/supabase/admin.ts` uses)
 *      under the "react-server" export condition, where it is a no-op.
 *      Outside that condition — which is exactly the situation a plain
 *      `node` invocation is in — the package's default export THROWS at
 *      import time. `vitest.config.ts` papers over this today with a resolve
 *      alias to the package's own no-op build; there is no equivalent for a
 *      plain `node` run.
 *
 * So, exactly as `scripts/invite.ts` does, this registers a minimal,
 * in-process ES module resolution hook, scoped to exactly these two
 * problems, before doing anything else:
 *
 *   - "server-only" resolves to a no-op module (mirrors vitest's alias).
 *   - a "@/x" specifier is rewritten to an absolute file URL under the repo
 *     root, and any local specifier (rewritten or plain-relative) that fails
 *     to resolve without an extension is retried once with ".ts" appended.
 *
 * `--experimental-transform-types`, not `--experimental-strip-types`: see
 * `scripts/invite.ts`'s header for why strip-only mode does not work in this
 * repo (`lib/http/errors.ts` uses a TypeScript parameter-property
 * constructor, which strip-only mode rejects outright).
 */

import { register } from "node:module";
import process from "node:process";

const REPO_ROOT = new URL("../", import.meta.url).href;

// Must run before any "@/..." or extension-omitted local module is touched —
// see the file header. Everything after this point that needs such a module
// uses a dynamic import(), never a static one: static imports in this file
// would already have been resolved (and would already have failed) before
// this line ever executed.
register(
  `data:text/javascript,${encodeURIComponent(`
    const ROOT = ${JSON.stringify(REPO_ROOT)};
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === "server-only") {
        return { url: "data:text/javascript,export default {}", shortCircuit: true };
      }
      const spec = specifier.startsWith("@/")
        ? new URL(specifier.slice(2), ROOT).href
        : specifier;
      try {
        return await nextResolve(spec, context);
      } catch (err) {
        const isLocal = spec.startsWith(".") || spec.startsWith("file://");
        const hasExt = /\\.[a-zA-Z0-9]+$/.test(spec);
        if (isLocal && !hasExt && err && err.code === "ERR_MODULE_NOT_FOUND") {
          return await nextResolve(spec + ".ts", context);
        }
        throw err;
      }
    }
  `)}`,
  import.meta.url,
);

function usage(): never {
  console.error("usage: npm run grant-super-admin -- <email>");
  process.exit(1);
}

async function main() {
  const [email] = process.argv.slice(2);
  if (!email) usage();

  const { createAdminClient } = await import("../lib/supabase/admin");
  const supabase = createAdminClient();

  // supabase-js has no admin "get user by email" call — paginate listUsers
  // and match by email, same constraint `lib/admin/invite.ts` documents for
  // the same reason (and the same 1000-row page size).
  const { data: page, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) {
    console.error(`error listing users: ${listErr.message}`);
    process.exit(1);
  }

  const user = page.users.find(
    (u: { id: string; email?: string }) => u.email?.toLowerCase() === email.toLowerCase(),
  );
  if (!user) {
    console.error(
      `no account found for "${email}" — they must be invited first ` +
        `(npm run invite -- <email> <org-slug> <role>, or the console) ` +
        `before super admin can be granted.`,
    );
    process.exit(1);
  }

  const { error: upsertErr } = await supabase
    .from("platform_admins")
    .upsert({ user_id: user.id, granted_by: null }, { onConflict: "user_id" });
  if (upsertErr) {
    console.error(`error granting super admin to "${email}": ${upsertErr.message}`);
    process.exit(1);
  }

  console.log(JSON.stringify({ user_id: user.id, email: user.email ?? email }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
