import { NextResponse } from "next/server";
import { requireEditor, requireFounder } from "@/lib/auth/session";
import { z } from "zod";
import { AppError } from "@/lib/utils";
import { assertSameOrigin } from "@/lib/auth/request";
import { syncEmailAccount } from "@/lib/email/sync";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireEditor();
    const { id } = await context.params;
    z.string().uuid().parse(id);
    const text = await request.text();
    let raw: unknown;
    try { raw = text.trim() ? JSON.parse(text) : { mode: "incremental" }; }
    catch { throw new AppError("Invalid sync request.", 400); }
    const options = z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("incremental") }).strict(),
      z.object({ mode: z.literal("backfill"), confirmation: z.literal("IMPORT FULL MAILBOX HISTORY") }).strict(),
    ]).parse(raw);
    const founder = options.mode === "backfill" ? await requireFounder() : null;
    // This endpoint never grants linking or historical suppression authority.
    const result = await syncEmailAccount(id, { mode: options.mode, ...(founder ? { founderUserId: founder.id } : {}) });
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return fail(error);
  }
}
