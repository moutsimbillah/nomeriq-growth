import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { processQueuedSends } from "@/lib/services/email-sending";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * The send queue.
 *
 * A send held back by the account's own minimum interval is queued rather than refused, and this is
 * what sends it once the gap has passed. It also picks up a queued campaign item, since a campaign
 * send goes through the same ledger.
 *
 * A scheduler calls this on a short cadence (a timer of its own — this is deliberately not folded into
 * the research worker, which never sends email by design). Each invocation takes a bounded batch,
 * oldest first, and every candidate still passes the full send gate: a queued draft whose prospect has
 * since opted out is refused here exactly as it would be from the interface.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET is not configured." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Fail closed if the database is unreachable, rather than reporting a fabricated result.
  const db = await getDb();
  await db.query("SELECT 1");

  const result = await processQueuedSends({
    max: Number(process.env.QUEUED_SEND_MAX ?? 5),
  });
  return NextResponse.json({ ok: true, data: result });
}
