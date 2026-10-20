import { NextRequest, NextResponse } from "next/server";
import { buildProtectedResourceMetadata } from "@/lib/oauth/discovery";
import { issuerFromRequest } from "@/lib/oauth/issuer";
import { isValidOrgSlug } from "@/lib/policy/slug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ org: string; app: string }> },
) {
  const { org, app } = await params;

  // Syntactic validation only — never a catalog lookup. Serving this document
  // for any well-formed slug pair is what keeps a known (org, app) and an
  // unknown one indistinguishable (phase 2 spec §3). A 404 here would turn
  // discovery into an org-enumeration oracle, and would also hand an RFC 9728
  // client the Next.js HTML 404 page that finding S6 documented as looking
  // like a broken gateway.
  if (!isValidOrgSlug(org) || !isValidOrgSlug(app)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json(
    buildProtectedResourceMetadata(issuerFromRequest(req), org, app),
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
