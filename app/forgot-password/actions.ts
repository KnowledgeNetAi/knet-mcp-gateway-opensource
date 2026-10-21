"use server";

import { redirect } from "next/navigation";
import { emailLinkOrigin } from "@/lib/http/origin";
import { createClient } from "@/lib/supabase/server";

export async function requestPasswordResetAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const origin = await emailLinkOrigin();
  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/confirm?next=/set-password`,
  });
  // Always the same destination whether or not the address exists — the
  // confirmation page must not become an account-enumeration oracle.
  redirect(`/forgot-password/sent?email=${encodeURIComponent(email)}`);
}
