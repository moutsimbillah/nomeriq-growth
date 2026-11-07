import { NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { testLeadResearchConnection } from "@/lib/services/research-routing";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    // No provider ids, endpoint URLs, keys or model overrides are accepted from the browser.
    return NextResponse.json({ ok: true, data: await testLeadResearchConnection() });
  } catch (error) { return fail(error); }
}
