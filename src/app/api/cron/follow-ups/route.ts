import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { prepareFollowUpDrafts } from "@/lib/services/followups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not configured." },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const db = await getDb();
  const founder = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE role = 'founder' AND is_active = true ORDER BY created_at LIMIT 1`,
  );
  const userId = founder.rows[0]?.id;
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: "No active founder account." },
      { status: 503 },
    );
  }
  // This cron only prepares drafts. Sending remains founder-authorized.
  const drafts = await prepareFollowUpDrafts({ userId });
  return NextResponse.json({
    ok: true,
    data: {
      prepared: drafts.length,
      draftIds: drafts.map((draft) => draft.id),
      note: "Drafts prepared only. No email was sent.",
    },
  });
}
