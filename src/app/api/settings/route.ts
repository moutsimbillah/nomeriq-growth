import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { updateWorkspaceSettings } from "@/lib/services/settings";
import { fail, readJson } from "@/lib/api";
import { isValidTimezone } from "@/lib/dates/timezone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  legalBusinessName: z.string().min(1).max(200).optional(),
  postalAddress: z.string().max(500).optional(),
  postalAddressEnabled: z.boolean().optional(),
  senderSignature: z.string().max(1000).optional(),
  senderSignatureEnabled: z.boolean().optional(),
  footerNote: z.string().max(2000).optional(),
  followUpMax: z.number().int().min(0).max(3).optional(),
  // Automatic follow-ups: off unless switched on, and a day's quota, bounded to match the CHECK.
  followUpAutoEnabled: z.boolean().optional(),
  followUpDailyLimit: z.number().int().min(0).max(50).optional(),
  followUpDelay1Days: z.number().int().min(1).max(60).optional(),
  followUpDelay2Days: z.number().int().min(1).max(60).optional(),
  syncStaleHours: z.number().int().min(1).max(720).optional(),
  timezone: z
    .string()
    .min(1)
    .max(100)
    .refine(isValidTimezone, "Choose a valid IANA timezone.")
    .optional(),
  // Autonomous research defaults. Bounded to match the workspace_settings
  // CHECK constraints so an invalid value fails here with a clear message.
  researchDefaultBudgetUsd: z.number().positive().max(1000).optional(),
  researchDefaultConcurrency: z.number().int().min(1).max(8).optional(),
  // Integer check only here: the 1..5 DeepSeek ceiling is enforced in
  // updateWorkspaceSettings so an oversized value returns its clear AppError.
  deepseekSearchQps: z.number().int().optional(),
  deepseekFetchQps: z.number().int().optional(),
});

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const input = schema.parse(await readJson(request));
    return NextResponse.json({
      ok: true,
      data: await updateWorkspaceSettings(input, user.id),
    });
  } catch (error) {
    return fail(error);
  }
}
