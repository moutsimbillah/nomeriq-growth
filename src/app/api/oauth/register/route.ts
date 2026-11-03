import { NextResponse } from "next/server";

import { fail, readJson } from "@/lib/api";
import { registerOAuthClient } from "@/lib/oauth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 7591 dynamic client registration — this is what claude.ai and ChatGPT call first. */
export async function POST(request: Request) {
  try {
    const body = await readJson<Record<string, unknown>>(request);

    const registered = await registerOAuthClient({
      clientName: body.client_name ?? body.clientName,
      redirectUris: body.redirect_uris ?? body.redirectUris,
    });

    return NextResponse.json(
      {
        client_id: registered.clientId,
        client_secret: registered.clientSecret,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: registered.clientName,
        redirect_uris: registered.redirectUris,
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
        scope: "research:read research:write drafts:write progress:read product_truth:read",
      },
      {
        status: 201,
        headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return fail(error);
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}