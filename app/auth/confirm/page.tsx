import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { readConfirmIntent, confirmCopy } from "@/lib/auth/confirm-link";
import { confirmLinkAction } from "./actions";
import {
  AuthFrame,
  AuthPanel,
  AuthSubmit,
} from "@/components/auth/frame";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  // The URL carries a single-use token — keep it out of Referer headers.
  referrer: "no-referrer",
};

type SearchParams = Promise<{
  token_hash?: string;
  type?: string;
  code?: string;
  next?: string;
}>;

/**
 * Landing page for Supabase email links (invite, recovery, signup, email
 * change). Rendering this page deliberately has **no side effects**: it does
 * not verify the token, so a mail-security scanner that pre-fetches every
 * link in the message leaves the token unspent. The recipient's click submits
 * `confirmLinkAction` (a POST-only Server Action), which is what redeems it.
 */
export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const intent = readConfirmIntent(sp);

  if (intent.kind === "invalid") {
    redirect("/login?error=invalid_link");
  }

  const { heading, cta } = confirmCopy(intent);

  return (
    <AuthFrame
      eyebrow="Access / Verify"
      title={heading}
      lede="One click to confirm it's you, then you'll choose your password."
    >
      <AuthPanel>
        <form action={confirmLinkAction} className="auth-form">
          <input type="hidden" name="next" value={intent.next} />
          {intent.kind === "otp" ? (
            <>
              <input type="hidden" name="token_hash" value={intent.tokenHash} />
              <input type="hidden" name="type" value={intent.type} />
            </>
          ) : (
            <input type="hidden" name="code" value={intent.code} />
          )}
          <AuthSubmit>{cta}</AuthSubmit>
        </form>
      </AuthPanel>

      <p className="auth-meta">Single use · expires 1 hour after it was sent</p>
      <p className="auth-note">
        We ask for this click because some email providers open links
        automatically to scan them, which would otherwise use up your link
        before you got here.
      </p>
    </AuthFrame>
  );
}
