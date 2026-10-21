"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function updatePasswordAction(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length < 8) {
    redirect("/set-password?error=too_short");
  }
  if (password !== confirm) {
    redirect("/set-password?error=mismatch");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    // Session never got established (expired/used link) — bounce to login.
    redirect("/login?error=session_expired");
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    // A fixed code, never Supabase's message: the page shows only text it
    // owns, so a crafted `?error=` link cannot put words on it.
    const code = (error as { code?: string }).code;
    redirect(`/set-password?error=${code === "weak_password" || code === "same_password" ? code : "update_failed"}`);
  }
  redirect("/");
}
