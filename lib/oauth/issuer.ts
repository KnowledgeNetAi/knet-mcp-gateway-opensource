import "server-only";
import type { NextRequest } from "next/server";
import { originFromHeaderPair } from "@/lib/http/origin";

/**
 * Derive the bare-origin issuer URL from a Next request. Reads
 * `x-forwarded-proto` / `x-forwarded-host` (set by Vercel and any sane proxy),
 * falling back to the `host` header for local-dev. Defaults proto to "https"
 * — safe for production where the header is always set; behind a localhost
 * curl with no forwarded headers, this yields `https://localhost:PORT` which
 * is harmless for discovery but would mis-match real OAuth client expectations.
 */
export function issuerFromRequest(req: NextRequest): string {
  return originFromHeaderPair(
    req.headers.get("x-forwarded-proto"),
    req.headers.get("x-forwarded-host") ?? req.headers.get("host"),
  );
}
