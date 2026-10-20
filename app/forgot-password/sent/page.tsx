import type { Metadata } from "next";
import { AuthFrame, AuthLink } from "@/components/auth/frame";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

type SearchParams = Promise<{ email?: string }>;

// Only echo back something that actually looks like an address, so the page
// can't be used to render arbitrary text at a victim.
function displayEmail(raw: string | undefined): string | null {
  if (!raw) return null;
  const email = raw.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254
    ? email
    : null;
}

export default async function ResetLinkSentPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const email = displayEmail((await searchParams).email);

  return (
    <AuthFrame
      eyebrow="Access / Recovery"
      title="Check your inbox"
      lede={
        email ? (
          <>
            If an account exists for{" "}
            <span className="auth-emphasis">{email}</span>, a reset link is on
            its way.
          </>
        ) : (
          "If that email matches an account, a reset link is on its way."
        )
      }
    >
      <div className="auth-steps">
        {[
          {
            k: "01",
            title: "Open the link within the hour",
            body: "It expires 60 minutes after it was sent and works only once.",
          },
          {
            k: "02",
            title: "Confirm on the landing page",
            body: "The link opens a page with a button to continue. That extra click is deliberate — it keeps inbox security scanners from spending your link before you do.",
          },
          {
            k: "03",
            title: "Nothing after a few minutes?",
            body: "Check spam and junk folders, then request another link.",
          },
        ].map((step) => (
          <div key={step.k} className="auth-step">
            <span className="auth-step-num">{step.k}</span>
            <div>
              <div className="auth-step-title">{step.title}</div>
              <p className="auth-step-body">{step.body}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="auth-links-split">
        <AuthLink href="/forgot-password">Send another link</AuthLink>
        <AuthLink href="/login">Back to sign in →</AuthLink>
      </div>
    </AuthFrame>
  );
}
