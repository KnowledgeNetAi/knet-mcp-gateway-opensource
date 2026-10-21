import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  generateClientId,
  validateRedirectUris,
  validateGrantTypes,
} from "@/lib/oauth/clients";
import { rateLimit } from "@/lib/oauth/rate-limit";
import { clientIp } from "@/lib/oauth/client-ip";
import { sweepUnusedClients } from "@/lib/oauth/cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DcrRequest = {
  client_name?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  token_endpoint_auth_method?: string;
};

function dcrError(code: string, description: string, status = 400) {
  return NextResponse.json(
    { error: code, error_description: description },
    { status },
  );
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const rl = rateLimit(`dcr:${ip}`, 5, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } },
    );
  }

  let body: DcrRequest;
  try {
    body = (await req.json()) as DcrRequest;
  } catch {
    return dcrError("invalid_client_metadata", "body is not JSON");
  }

  if (!body.client_name || typeof body.client_name !== "string") {
    return dcrError("invalid_client_metadata", "client_name required");
  }
  if (body.client_name.length > 200) {
    return dcrError("invalid_client_metadata", "client_name max 200 chars");
  }
  const clientName = body.client_name;

  const ru = validateRedirectUris(body.redirect_uris);
  if (!ru.ok) return dcrError(ru.error, "redirect_uris must be https or http://localhost");

  const gt = validateGrantTypes(body.grant_types);
  if (!gt.ok) return dcrError(gt.error, "unsupported grant_type");

  const clientId = generateClientId();
  const supabase = createAdminClient();
  const { error } = await supabase.from("oauth_clients").insert({
    client_id: clientId,
    client_name: clientName,
    redirect_uris: body.redirect_uris,
    grant_types: body.grant_types ?? ["authorization_code", "refresh_token"],
    token_endpoint_auth_method:
      body.token_endpoint_auth_method ?? "none",
    registered_by: null,
  });
  if (error) {
    console.error(JSON.stringify({ event: "dcr.error", message: error.message, ip }));
    return dcrError("invalid_client_metadata", "registration failed");
  }

  console.log(
    JSON.stringify({
      event: "dcr.registered",
      client_id: clientId,
      client_name: clientName,
      redirect_uris: body.redirect_uris,
      ip,
    }),
  );

  // Registration spam is exactly what leaves unused clients behind, so sweep
  // here too, not only on token exchange. Sampled, fire-and-forget.
  void sweepUnusedClients(supabase).catch(() => {});

  return NextResponse.json(
    {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: body.redirect_uris,
      grant_types: body.grant_types ?? ["authorization_code", "refresh_token"],
      token_endpoint_auth_method:
        body.token_endpoint_auth_method ?? "none",
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    {
      status: 201,
      headers: { "cache-control": "no-store" },
    },
  );
}
