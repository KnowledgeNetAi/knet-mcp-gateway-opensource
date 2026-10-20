import { NextResponse, type NextRequest } from "next/server";
import { getViewer } from "@/lib/authz/viewer";
import { zipPluginForOrg } from "@/lib/plugins/catalog";
import { issuerFromRequest } from "@/lib/oauth/issuer";

export const dynamic = "force-dynamic";

/**
 * Downloads an org's Claude plugin as a zip for upload to claude.ai
 * (Customize > Plugins > Upload). Members of the org only: a signed-out
 * visitor is sent to sign in and brought back here; anyone else gets the same
 * 404 as a plugin that does not exist, so the URL reveals nothing about which
 * orgs have plugins.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ org: string; plugin: string }> },
) {
  const { org, plugin } = await params;

  const viewer = await getViewer();
  if (!viewer) {
    // The public origin from the proxy headers, not request.nextUrl: behind
    // Cloud Run that is the container's own 0.0.0.0:8080.
    const login = new URL("/login", issuerFromRequest(request));
    login.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(login);
  }

  const isMember = viewer.isSuperAdmin || viewer.orgs.some((o) => o.slug === org);
  const result = isMember ? zipPluginForOrg(org, plugin) : null;
  if (!result) return new NextResponse("Not found", { status: 404 });

  const filename = `${result.summary.name}-${result.summary.version}.zip`;
  return new NextResponse(Buffer.from(result.zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
