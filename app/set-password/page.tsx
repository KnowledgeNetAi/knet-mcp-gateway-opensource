import { updatePasswordAction } from "./actions";
import {
  AuthFrame,
  AuthPanel,
  AuthField,
  AuthSubmit,
  AuthNotice,
} from "@/components/auth/frame";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ error?: string }>;

const ERRORS: Record<string, { label: string; detail: string }> = {
  too_short: {
    label: "Too short",
    detail: "Passwords need at least 8 characters.",
  },
  mismatch: {
    label: "Passwords don't match",
    detail: "The two entries were different. Try again.",
  },
  weak_password: {
    label: "Password too weak",
    detail: "Choose a longer password that is harder to guess.",
  },
  same_password: {
    label: "Same as before",
    detail: "Choose a password you have not used for this account.",
  },
  update_failed: {
    label: "Couldn't save",
    detail: "Your password was not changed. Try again, or request a new link.",
  },
};

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const known = sp.error ? ERRORS[sp.error] : null;
  const error = sp.error ? (known ?? ERRORS.update_failed) : null;

  return (
    <AuthFrame
      eyebrow="Access / Password"
      title="Set your password"
      lede="Choose a password for your account. You'll use it to sign in from now on."
    >
      {error && (
        <AuthNotice tone="error" label={error.label}>
          {error.detail}
        </AuthNotice>
      )}

      <AuthPanel>
        <form action={updatePasswordAction} className="auth-form">
          <AuthField
            label="New password"
            hint="8+ characters"
            name="password"
            type="password"
            required
            minLength={8}
            autoFocus
            autoComplete="new-password"
            placeholder="••••••••"
          />
          <AuthField
            label="Confirm password"
            name="confirm"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="••••••••"
          />
          <AuthSubmit>Save password</AuthSubmit>
        </form>
      </AuthPanel>
    </AuthFrame>
  );
}
