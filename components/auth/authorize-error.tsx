import {
  AUTHORIZE_ERRORS,
  type AuthorizeErrorCode,
} from "@/lib/oauth/authorize-request";
import { AuthFrame, AuthNotice, AuthLink } from "@/components/auth/frame";

/**
 * The refusal screen for an authorization request that never reached consent.
 *
 * Every case here is one where the spec forbids redirecting to `redirect_uri`
 * — the client is unknown, disabled, or the return address doesn't match its
 * registration — so the flow has to dead-end somewhere a person can read.
 * Rendered by both halves of the endpoint: inline by the consent page, and via
 * `/oauth/authorize/error?code=…` by the decision handler.
 */
export function AuthorizeError({ code }: { code: AuthorizeErrorCode }) {
  const { title, detail } = AUTHORIZE_ERRORS[code];
  return (
    <AuthFrame
      eyebrow="Authorize"
      title={title}
      lede="This request didn't get far enough to ask you for anything."
    >
      <AuthNotice tone="error" label={code.replace(/_/g, " ")}>
        {detail}
      </AuthNotice>
      <div className="auth-links">
        <AuthLink href="/">Back to sign in</AuthLink>
      </div>
    </AuthFrame>
  );
}
