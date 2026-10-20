import { requestPasswordResetAction } from "./actions";
import {
  AuthFrame,
  AuthPanel,
  AuthField,
  AuthSubmit,
  AuthLink,
} from "@/components/auth/frame";

export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  return (
    <AuthFrame
      eyebrow="Access / Recovery"
      title="Reset password"
      lede="We'll email you a single-use link to choose a new password."
    >
      <AuthPanel>
        <form action={requestPasswordResetAction} className="auth-form">
          <AuthField
            label="Email"
            name="email"
            type="email"
            required
            autoFocus
            autoComplete="username"
            placeholder="you@example.com"
          />
          <AuthSubmit>Email me a reset link</AuthSubmit>
        </form>
      </AuthPanel>

      <div className="auth-links">
        <AuthLink href="/login">← Back to sign in</AuthLink>
      </div>
    </AuthFrame>
  );
}
