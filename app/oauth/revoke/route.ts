import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseKey, hashKey } from "@/lib/auth/api-key";
import { REFRESH_TOKEN_PREFIX_LEN } from "@/lib/oauth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * RFC 7009 token revocation.
 *
 * The presented `token` may be either an access token
 * (`kngw_<org>_<hex>.<secret>` -- looked up the same way `authenticateApiKey`
 * does, via `parseKey`'s recovered prefix and a hash of the whole token) or a
 * refresh token (`kngwr_...` -- never key-shaped, never resolved through
 * `parseKey`, looked up instead by its own prefix/hash columns). Both live in
 * `api_keys`, so both are revoked with the same `revoked_at` column.
 */
export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";
  const form = ct.includes("application/x-www-form-urlencoded")
    ? await req.formData()
    : new URLSearchParams(await req.text());
  const token = String(form.get("token") ?? "");
  // token_type_hint is optional per RFC 7009; we look up by both kinds
  // regardless of whatever hint (if any) the caller sends.

  if (!token) {
    return NextResponse.json(
      { error: "invalid_request" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const supabase = createAdminClient();

  // Try as an access token first.
  const parsed = parseKey(token);
  if (parsed) {
    const accessRes = await supabase
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("prefix", parsed.prefix)
      .eq("hash", hashKey(token))
      .is("revoked_at", null)
      .select("id")
      .maybeSingle();
    if (accessRes.data) {
      console.log(JSON.stringify({ event: "token.revoked", kind: "access", prefix: parsed.prefix }));
      return new NextResponse(null, { status: 200, headers: { "cache-control": "no-store" } });
    }
  }

  // Otherwise, try as a refresh token.
  const refreshPrefix = token.slice(0, REFRESH_TOKEN_PREFIX_LEN);
  const refreshRes = await supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("refresh_token_prefix", refreshPrefix)
    .eq("refresh_token_hash", sha256(token))
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (refreshRes.data) {
    console.log(JSON.stringify({ event: "token.revoked", kind: "refresh", prefix: refreshPrefix }));
    return new NextResponse(null, { status: 200, headers: { "cache-control": "no-store" } });
  }

  // RFC 7009 §2.2: respond 200 even for invalid tokens to avoid leaking
  // validity info. Don't log unknown-token attempts, to keep the log clean.
  return new NextResponse(null, { status: 200, headers: { "cache-control": "no-store" } });
}
