import { handleMcpRequest } from "@/lib/mcp/handler";
import { extractKey, handlerDeps } from "@/lib/mcp/route-deps";
import { mcpMethodNotAllowed } from "@/lib/mcp/not-allowed";
import { originFromHeaderPair } from "@/lib/http/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ org: string; app: string }> },
) {
  const { org, app } = await params;
  return handleMcpRequest({
    orgSlug: org,
    appSlug: app,
    body: await req.json().catch(() => null),
    apiKey: extractKey(req),
    deps: handlerDeps(),
    // Same header-read `issuerFromRequest` performs, done directly here since
    // this handler receives a plain `Request`, not a `NextRequest`.
    issuer: originFromHeaderPair(
      req.headers.get("x-forwarded-proto"),
      req.headers.get("x-forwarded-host") ?? req.headers.get("host"),
    ),
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ org: string; app: string }> },
) {
  const { org, app } = await params;
  return mcpMethodNotAllowed(req, org, app);
}
