import { signInAction } from "./actions";
import {
  AuthFrame,
  AuthPanel,
  AuthField,
  AuthSubmit,
  AuthNotice,
  AuthLink,
} from "@/components/auth/frame";

type SearchParams = Promise<{ next?: string; error?: string }>;

const ERRORS: Record<string, { label: string; detail: string }> = {
  invalid_credentials: {
    label: "Sign-in failed",
    detail: "That email and password combination didn't match an account.",
  },
  link_expired: {
    label: "Link expired",
    detail:
      "That link has already been used or has passed its one-hour window. Use “Forgot your password?” to send a fresh one.",
  },
  invalid_link: {
    label: "Link not valid",
    detail:
      "That link is missing the token we need. Use “Forgot your password?” to send a fresh one.",
  },
  session_expired: {
    label: "Session expired",
    detail: "Sign in again to pick up where you left off.",
  },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const error = sp.error ? ERRORS[sp.error] : null;

  return (
    <AuthFrame
      eyebrow="Access"
      title="Sign in"
      lede="Sign in to reach your organization's gateway tools."
    >
      {error && (
        <AuthNotice tone="error" label={error.label}>
          {error.detail}
        </AuthNotice>
      )}

      <AuthPanel>
        <form action={signInAction} className="auth-form">
          <input type="hidden" name="next" value={sp.next ?? ""} />
          <AuthField
            label="Email"
            name="email"
            type="email"
            required
            autoComplete="username"
            placeholder="you@example.com"
          />
          <AuthField
            label="Password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            placeholder="••••••••"
          />
          <AuthSubmit>Sign in</AuthSubmit>
        </form>
      </AuthPanel>

      <div className="auth-links">
        <AuthLink href="/forgot-password">Forgot your password?</AuthLink>
      </div>
    </AuthFrame>
  );
}
