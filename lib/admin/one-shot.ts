import "server-only";
import { cookies } from "next/headers";

/**
 * Hands a secret from a Server Action to the page it redirects to, without
 * putting it in the URL.
 *
 * The obvious mechanism — `redirect(\`...?issuedKey=\${key}\`)` — writes the
 * secret into a place designed to be recorded: Cloud Run's access log, the
 * browser's history and address bar, and the `Referer` of whatever the user
 * clicks next. Hashing API keys at rest buys nothing if the plaintext is
 * logged verbatim on the way out.
 *
 * A cookie avoids all three. It is `httpOnly` (no script can read it),
 * `sameSite: "strict"` (never sent on a cross-site navigation), scoped by
 * `path` to the single page that renders it, and short-lived.
 *
 * WHY IT EXPIRES RATHER THAN BEING DELETED ON READ: a Server Component
 * cannot set or clear cookies — only a Server Action or Route Handler can
 * (the same constraint `lib/supabase/server.ts` documents around its
 * `setAll`). So the reading page cannot unset it, and a short `maxAge` is
 * what bounds the exposure instead. Keep it small; this is a value the user
 * is looking at right now, not one they need later.
 */
const MAX_AGE_SECONDS = 120;

export async function setOneShotSecret(name: string, value: string, path: string): Promise<void> {
  const store = await cookies();
  store.set(name, value, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path,
    maxAge: MAX_AGE_SECONDS,
  });
}

/** Reads a one-shot secret. Returns null when absent or already expired. */
export async function readOneShotSecret(name: string): Promise<string | null> {
  const store = await cookies();
  return store.get(name)?.value ?? null;
}
