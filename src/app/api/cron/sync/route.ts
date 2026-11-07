import { NextResponse } from "next/server";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Scheduled mailbox writes stay unavailable until a separately reviewed runner verifies a
 * fresh backup before every run. Part 1 installs no sync timer. Keep authentication, but do
 * not initialize the database, enumerate accounts or invoke a mailbox writer here.
 * The session-authenticated, same-origin manual account-sync route remains unchanged.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET is not configured." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    ok: false,
    code: "scheduled_sync_unavailable",
    error: "Automatic mailbox sync is unavailable until its per-run backup safeguards are ready. Use Sync mailbox for a manual sync. No mailbox operation was started.",
  }, { status: 503 });
}