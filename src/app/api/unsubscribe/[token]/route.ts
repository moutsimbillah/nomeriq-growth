import { NextResponse } from "next/server";
import { unsubscribeByToken } from "@/lib/services/suppressions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await context.params;
    const result = await unsubscribeByToken(token);
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Invalid unsubscribe link.",
      },
      { status: 400 },
    );
  }
}
