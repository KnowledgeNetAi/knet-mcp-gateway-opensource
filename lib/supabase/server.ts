import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Cookie-session Supabase client for signed-in users (login, consent, etc.),
 * distinct from the service-role admin client in `lib/supabase/admin.ts`.
 *
 * Uses the PUBLISHABLE/anon key — SUPABASE_ANON_KEY — never
 * SUPABASE_SERVICE_ROLE_KEY. Handing the service-role key to a
 * browser-session client would give every visitor full database access.
 *
 * Deliberately NOT named NEXT_PUBLIC_*. Next inlines NEXT_PUBLIC_ values at
 * BUILD time, and `next build` runs inside the Docker image build where no
 * Cloud Run environment exists — so a NEXT_PUBLIC_ name would bake in
 * `undefined` and every page would 500 at runtime while /mcp/* kept working,
 * which is a confusing way to discover a config problem. Nothing here runs in
 * a browser (no client components, no createBrowserClient), so the prefix
 * bought nothing and cost correctness.
 */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Components cannot set cookies; safe to ignore.
          }
        },
      },
    },
  );
}
