import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/agent/apiKeys";
import { runAgentAction } from "@/lib/agent/service";
import { corsHeaders, preflight } from "@/lib/api/cors";
import { AppError } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  const cors = corsHeaders(request);
  try {
    const { action } = await context.params;
    const key = await authenticateApiKey(request);
    let args: Record<string, unknown> = {};
    const text = await request.text();
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        throw new AppError("Request body must be a JSON object.", 400);
      }
    }
    const result = await runAgentAction(key, action, args);
    return NextResponse.json({ ok: true, data: result.data }, { headers: cors });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json(
        { ok: false, error: error.message, code: error.code },
        { status: error.status, headers: cors },
      );
    }
    console.error("Agent API error", error);
    return NextResponse.json(
      { ok: false, error: "The Growth API request failed." },
      { status: 500, headers: cors },
    );
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  const cors = corsHeaders(request);
  try {
    const { action } = await context.params;
    return NextResponse.json(
      {
        ok: false,
        error: `Use POST /api/agent/v1/${action} with a JSON object and a Bearer API key.`,
      },
      { status: 405, headers: cors },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: "Invalid action." },
      { status: 400, headers: cors },
    );
  }
}

export async function OPTIONS(request: Request) {
  return preflight(request);
}


