import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/agent/apiKeys";
import { runAgentAction } from "@/lib/agent/service";
import { AppError } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
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
    return NextResponse.json({ ok: true, data: result.data });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json(
        { ok: false, error: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error("Agent API error", error);
    return NextResponse.json(
      { ok: false, error: "The Growth API request failed." },
      { status: 500 },
    );
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ action: string }> },
) {
  try {
    const { action } = await context.params;
    return NextResponse.json(
      {
        ok: false,
        error: `Use POST /api/agent/v1/${action} with a JSON object and a Bearer API key.`,
      },
      { status: 405 },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: "Invalid action." },
      { status: 400 },
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
  });
}


