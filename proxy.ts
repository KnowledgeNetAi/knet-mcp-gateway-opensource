import { NextResponse, type NextRequest } from "next/server";
import { canonicalOrigin, canonicalRedirect } from "@/lib/http/canonical-host";

/** Send browser page loads on a platform host to `CANONICAL_ORIGIN`, when it is set. */
export function proxy(req: NextRequest) {
  const target = canonicalRedirect({
    method: req.method,
    host: req.headers.get("x-forwarded-host") ?? req.headers.get("host"),
    pathname: req.nextUrl.pathname,
    search: req.nextUrl.search,
    canonical: canonicalOrigin(),
  });
  return target ? NextResponse.redirect(target, 308) : NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
