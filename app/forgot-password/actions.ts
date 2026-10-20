"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

/**
 * Derive the bare-origin URL (e.g. `https://<host>`) from the incoming
 * request headers inside this Server Action. Mirrors `issuerFromRequest`
 * (`lib/oauth/issuer.ts`) but reads the async `headers()` store instead of a
 * NextRequest, since a Server Action has no request object to read from.
 * Reads `x-forwarded-proto`/`x-forwarded-host` (set by Vercel/Cloud Run and
 * any sane proxy), falling back to `host` for local dev.
 *
 * Inlined here rather than factored into a shared `lib/http/` module: this
 * task's file list does not include a new shared lib file, and the ported
 * source's `lib/http/origin.ts` has no equivalent elsewhere in this repo or
 * plan.
 */
async function originFromHeaders(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host");
  return `${proto}://${host}`;
}

export async function requestPasswordResetAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const origin = await originFromHeaders();
  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/confirm?next=/set-password`,
  });
  // Always the same destination whether or not the address exists — the
  // confirmation page must not become an account-enumeration oracle.
  redirect(`/forgot-password/sent?email=${encodeURIComponent(email)}`);
}
