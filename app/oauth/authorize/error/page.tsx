import {
  AUTHORIZE_ERRORS,
  type AuthorizeErrorCode,
} from "@/lib/oauth/authorize-request";
import { AuthorizeError } from "@/components/auth/authorize-error";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ code?: string | string[] }>;

/**
 * Where `/oauth/authorize/decision` sends a browser when a POSTed request
 * fails validation. The code is looked up in `AUTHORIZE_ERRORS` and anything
 * unrecognized collapses to a generic failure, so the query string can't put
 * words of its own on a page wearing our branding.
 */
export default async function AuthorizeErrorPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const raw = (await searchParams).code;
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  const code: AuthorizeErrorCode =
    candidate && candidate in AUTHORIZE_ERRORS
      ? (candidate as AuthorizeErrorCode)
      : "code_issue_failed";
  return <AuthorizeError code={code} />;
}
