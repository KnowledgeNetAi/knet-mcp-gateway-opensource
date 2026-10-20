"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function safeNext(next: string | null): string {
  if (!next) return "/";
  if (!next.startsWith("/")) return "/";
  // Reject protocol-relative URLs ("//evil.com") and backslash variants
  // ("/\\evil.com") that browsers may interpret as cross-origin.
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

export async function signInAction(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = safeNext(String(formData.get("next") ?? ""));
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    redirect(`/login?next=${encodeURIComponent(next)}&error=invalid_credentials`);
  }
  redirect(next);
}
