"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { readConfirmIntent } from "@/lib/auth/confirm-link";

function field(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

/**
 * Redeem an email auth link. This is the *only* place the one-time token is
 * spent, and it is a Server Action — POST-only by construction. The emailed
 * URL is a plain page that renders a button pointing here, so link scanners
 * (Defender Safe Links, Proofpoint URL Defense, …) that GET every URL in an
 * inbox can't burn the token before the recipient clicks.
 */
export async function confirmLinkAction(formData: FormData) {
  const intent = readConfirmIntent({
    token_hash: field(formData, "token_hash"),
    type: field(formData, "type"),
    code: field(formData, "code"),
    next: field(formData, "next"),
  });

  if (intent.kind === "invalid") {
    redirect("/login?error=invalid_link");
  }

  const supabase = await createClient();

  if (intent.kind === "otp") {
    const { error } = await supabase.auth.verifyOtp({
      type: intent.type,
      token_hash: intent.tokenHash,
    });
    redirect(error ? "/login?error=link_expired" : intent.next);
  }

  const { error } = await supabase.auth.exchangeCodeForSession(intent.code);
  redirect(error ? "/login?error=link_expired" : intent.next);
}
