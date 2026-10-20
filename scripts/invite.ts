/**
 * npm run invite -- <email> <org-slug> <role>
 *
 * Onboards one customer user. This is now a thin CLI wrapper over the shared
 * `inviteMember` (`lib/admin/invite.ts`) — phase 3's admin console calls the
 * same function, so the org lookup, role validation, invite-or-find, and
 * membership/role upserts live in exactly one place. This file's job is just:
 * parse argv, call `inviteMember` with `adminRole: "member"` and a
 * one-element `dataRoles` array (a CLI run grants exactly one data role and
 * no platform-admin standing), and print the result.
 *
 * `invitedBy` is passed as `null`: a CLI run has no acting signed-in user to
 * attribute the invite to (unlike the console, which passes the org_admin's
 * own user id).
 *
 * Idempotent: if the email already belongs to a user, `inviteMember` treats
 * that as expected, not fatal — it looks up the existing user and continues
 * to the membership/role upserts. Re-running this command for someone
 * already invited is safe.
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
 *   2. Resolves `import "server-only"` (which `lib/supabase/admin.ts` and,
 *      transitively, `lib/mcp/catalog.ts` use) under the "react-server"
 *      export condition, where it is a no-op. Outside that condition — which
 *      is exactly the situation a plain `node` invocation is in — the
 *      package's default export THROWS at import time. `vitest.config.ts`
 *      papers over this today with a resolve alias to the package's own
 *      no-op build; there is no equivalent for a plain `node` run.
 *
 * Re-implementing getCatalog()/createAdminClient() here instead of importing
 * `lib/admin/invite.ts` (which imports both) would dodge both problems, but
 * it would also dodge the entire point of `inviteMember` validating data
 * roles against the SAME getCatalog() the request-time handler uses: a
 * second, hand-rolled reader of `roles.json` is exactly the kind of
 * git/DB-seam duplication that invites the two copies drifting apart. So
 * instead this registers a minimal, in-process ES module resolution hook,
 * scoped to exactly these two problems, before doing anything else:
 *
 *   - "server-only" resolves to a no-op module (mirrors vitest's alias).
 *   - a "@/x" specifier is rewritten to an absolute file URL under the repo
 *     root, and any local specifier (rewritten or plain-relative) that fails
 *     to resolve without an extension is retried once with ".ts" appended.
 *
 * Verified empirically against this repo's actual dependency graph (getCatalog()
 * pulls in lib/config/load.ts, lib/mcp/handler.ts, lib/policy/*, lib/http/errors.ts,
 * lib/audit/log.ts, lib/oauth/resource.ts — all "@/..." or extension-omitted
 * imports, and all load cleanly through this hook).
 *
 * `--experimental-transform-types`, not `--experimental-strip-types`: see the
 * commit message / task report for why strip-only mode does not work here
 * (`lib/http/errors.ts` uses a TypeScript parameter-property constructor,
 * which strip-only mode rejects outright).
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
  console.error("usage: npm run invite -- <email> <org-slug> <role>");
  process.exit(1);
}

async function main() {
  const [email, orgSlug, role] = process.argv.slice(2);
  if (!email || !orgSlug || !role) usage();

  const { inviteMember, InviteError } = await import("../lib/admin/invite");

  try {
    const result = await inviteMember({
      orgSlug,
      email,
      // Deliberately omitted, not "member": this script is documented as safe
      // to re-run, and writing the column would demote an existing org_admin.
      dataRoles: [role],
      invitedBy: null,
    });
    console.log(
      JSON.stringify(
        { user_id: result.userId, email: result.email, org_slug: result.orgSlug, role },
        null,
        2,
      ),
    );
  } catch (e) {
    if (e instanceof InviteError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
