import { NextResponse } from "next/server";

import { SUPPORTED_SCOPES } from "@/lib/oauth/server";
import { publicOrigin } from "@/lib/app-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 8414 authorization server metadata for the MCP connector flow. */
export async function GET(request: Request) {
  const origin = publicOrigin(request);

  return NextResponse.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/api/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
      scopes_supported: SUPPORTED_SCOPES,
      service_documentation: `${origin}/login`,
    },
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } },
  );
}