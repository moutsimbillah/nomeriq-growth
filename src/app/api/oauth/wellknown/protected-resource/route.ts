import { NextResponse } from "next/server";

import { SUPPORTED_SCOPES } from "@/lib/oauth/server";
import { publicOrigin } from "@/lib/app-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RFC 9728 protected resource metadata. An MCP client fetches this to discover which
 * authorization server protects the resource.
 */
export async function GET(request: Request) {
  const origin = publicOrigin(request);
  return NextResponse.json(
    {
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ["header"],
      resource_documentation: `${origin}/login`,
    },
    { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } },
  );
}