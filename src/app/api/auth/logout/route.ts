import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/auth/request";
import { clearSession } from "@/lib/auth/session";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await clearSession();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return fail(error);
  }
}
