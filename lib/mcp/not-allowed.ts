import { originFromHeaderPair } from "@/lib/http/origin";

/**
 * The response for a non-POST request to an MCP endpoint.
 *
 * MCP over HTTP is POST-only, so a browser GET here is already a 405 — Next
 * produces one automatically for a route that exports only POST. What it does
 * NOT produce is any explanation, so the first thing an administrator does
 * with a freshly copied endpoint URL (paste it in a browser to check it) shows
 * a bare error page and reads like a broken deployment.
 *
 * The status stays 405 and the `Allow` header stays accurate, so nothing about
 * how a client sees this endpoint changes; only the body becomes useful to a
 * person. Deliberately not a 200: an MCP client probing transports must still
 * see this method refused.
 */
export function mcpMethodNotAllowed(req: Request, orgSlug: string, appSlug: string | null): Response {
  const origin = originFromHeaderPair(
    req.headers.get("x-forwarded-proto"),
    req.headers.get("x-forwarded-host") ?? req.headers.get("host"),
  );
  const endpoint = appSlug ? `${origin}/mcp/${orgSlug}/${appSlug}` : `${origin}/mcp/${orgSlug}`;

  return Response.json(
    {
      error: "method_not_allowed",
      message:
        "This is an MCP endpoint. It speaks JSON-RPC over POST and has nothing to show in a browser — seeing this page means the URL is correct, not that anything is broken.",
      endpoint,
      connect: {
        "Claude Desktop, claude.ai, Cowork":
          "Add this URL as a custom connector. You'll be asked to sign in and approve the tools it may use.",
        "Claude Code":
          "claude mcp add --transport http <name> " + endpoint + ' --header "X-API-Key: <your key>"',
      },
      verify:
        `curl -X POST ${endpoint} -H "X-API-Key: <your key>" -H "Content-Type: application/json" ` +
        `-d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}
