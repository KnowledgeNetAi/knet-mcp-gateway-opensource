import type { EmailOtpType } from "@supabase/supabase-js";

/**
 * Parsing for Supabase email-link landing (`/auth/confirm`).
 *
 * Kept pure and free of `server-only` so both the page (GET, renders a
 * confirm button) and the Server Action (POST, actually redeems the token)
 * classify a link exactly the same way.
 */

// The OTP types Supabase can put in an email link. We enumerate them instead
// of casting `type` straight to EmailOtpType so a junk value from a crafted
// URL never reaches verifyOtp.
const EMAIL_OTP_TYPES: readonly EmailOtpType[] = [
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
];

export function isEmailOtpType(value: unknown): value is EmailOtpType {
  return (
    typeof value === "string" &&
    (EMAIL_OTP_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Where to send the caller once the link is redeemed. Only same-origin
 * absolute paths are honored, so a tampered `next` can't turn an auth link
 * into an open redirect.
 */
export function safeNext(next: string | null | undefined): string {
  if (
    !next ||
    !next.startsWith("/") ||
    next.startsWith("//") ||
    next.startsWith("/\\")
  ) {
    return "/set-password";
  }
  return next;
}

export type ConfirmIntent =
  | { kind: "otp"; tokenHash: string; type: EmailOtpType; next: string }
  | { kind: "pkce"; code: string; next: string }
  | { kind: "invalid" };

type ConfirmParams = {
  token_hash?: string | null;
  type?: string | null;
  code?: string | null;
  next?: string | null;
};

/**
 * Classify the credential carried by an auth link without redeeming it.
 * Supabase sends either `token_hash` + `type` (the `{{ .TokenHash }}` email
 * templates) or a PKCE `code`; anything else is not a usable link.
 */
export function readConfirmIntent(params: ConfirmParams): ConfirmIntent {
  const next = safeNext(params.next);
  const tokenHash = params.token_hash?.trim();
  const code = params.code?.trim();

  if (tokenHash && isEmailOtpType(params.type)) {
    return { kind: "otp", tokenHash, type: params.type, next };
  }
  if (code) {
    return { kind: "pkce", code, next };
  }
  return { kind: "invalid" };
}

/** Page copy, chosen by what the link is for. */
export function confirmCopy(intent: ConfirmIntent): {
  heading: string;
  cta: string;
} {
  if (intent.kind === "otp" && intent.type === "recovery") {
    return { heading: "Reset your password", cta: "Continue to reset password" };
  }
  if (intent.kind === "otp" && intent.type === "invite") {
    return { heading: "Accept your invitation", cta: "Continue to set password" };
  }
  return { heading: "Confirm your email", cta: "Continue" };
}
