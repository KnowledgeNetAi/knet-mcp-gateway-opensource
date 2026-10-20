import { NextRequest, NextResponse } from "next/server";
import { buildAuthorizationServerMetadata } from "@/lib/oauth/discovery";
import { issuerFromRequest } from "@/lib/oauth/issuer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const metadata = buildAuthorizationServerMetadata(issuerFromRequest(req));
  return NextResponse.json(metadata, {
    headers: { "cache-control": "public, max-age=300" },
  });
}
