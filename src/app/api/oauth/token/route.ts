import { NextResponse } from "next/server";

import { exchangeAuthorizationCode } from "@/lib/oauth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: string, description: string, status = 400) {
  return NextResponse.json(
    { error, error_description: description },
    {
      status,
      headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
    },
  );
}

/**
 * Token endpoint for the authorization-code grant. MCP clients send this as
 * application/x-www-form-urlencoded; a JSON body is accepted too for convenience.
 */
export async function POST(request: Request) {
  let params: Record<string, string> = {};

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    params = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, string>;
  } else {
    const form = await request.formData().catch(() => null);
    if (form) {
      for (const [key, value] of form.entries()) params[key] = String(value);
    }
  }

  // HTTP Basic client authentication takes precedence when present.
  const basic = request.headers.get("authorization")?.match(/^Basic\s+(.+)$/i)?.[1];
  if (basic) {
    const decoded = Buffer.from(basic, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator > 0) {
      params.client_id = params.client_id || decoded.slice(0, separator);
      params.client_secret = params.client_secret || decoded.slice(separator + 1);
    }
  }

  if (params.grant_type !== "authorization_code") {
    return jsonError("unsupported_grant_type", "Only authorization_code is supported.");
  }
  if (!params.code || !params.client_id) {
    return jsonError("invalid_request", "code and client_id are required.");
  }

  try {
    const token = await exchangeAuthorizationCode({
      code: params.code,
      clientId: params.client_id,
      clientSecret: params.client_secret ?? null,
      codeVerifier: params.code_verifier ?? null,
      redirectUri: params.redirect_uri ?? null,
    });

    return NextResponse.json(
      {
        access_token: token.accessToken,
        token_type: token.tokenType,
        expires_in: token.expiresIn,
        scope: token.scope,
      },
      { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : "Token exchange failed.";
    if (code === "invalid_client") return jsonError("invalid_client", message, 401);
    return jsonError("invalid_grant", message);
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