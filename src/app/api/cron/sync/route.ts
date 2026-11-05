import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { syncEmailAccount } from "@/lib/email/sync";
import { listEmailAccounts } from "@/lib/email/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The scheduled mailbox sync.
 *
 * Every connected profile is synced on one cadence, because the portal is meant to replace webmail: a
 * reply that only appears when the founder remembers to press Sync is a reply he may answer a day late.
 *
 * The run is bounded and honest about what it did:
 *  - **One profile at a time**, oldest sync first, up to `SYNC_MAX_ACCOUNTS` (default 3) per call. A
 *    second timer tick while the first is still running skips the busy account rather than stacking.
 *  - **Never fails the whole run for one mailbox.** Each account's error is reported in its own entry;
 *    the others still sync.
 *  - **Never sends anything.** Sync reads IMAP, writes rows, records bounces and writes Sent-folder
 *    copies for messages already sent. The send queue is a different timer, and no send path is
 *    reachable from here.
 *  - **Fails closed** without its secret or without a database.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET is not configured." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  await db.query("SELECT 1");

  const maxAccounts = Math.max(1, Number(process.env.SYNC_MAX_ACCOUNTS ?? 3));
  const accounts = (await listEmailAccounts())
    .filter((account) => account.provider !== "sandbox" && account.status !== "disabled")
    .sort((a, b) => {
      const left = a.lastSyncAt ? Date.parse(a.lastSyncAt) : 0;
      const right = b.lastSyncAt ? Date.parse(b.lastSyncAt) : 0;
      return left - right;
    })
    .slice(0, maxAccounts);

  const results: {
    accountId: string;
    ok: boolean;
    imported?: number;
    filled?: number;
    matched?: number;
    error?: string;
  }[] = [];

  for (const account of accounts) {
    try {
      const result = await syncEmailAccount(account.id);
      results.push({
        accountId: account.id,
        ok: true,
        imported: result.imported,
        matched: result.rematched?.matched ?? 0,
      });
    } catch (error) {
      results.push({
        accountId: account.id,
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 200) : "Sync failed.",
      });
    }
  }

  return NextResponse.json({
    ok: true,
    data: {
      synced: results.filter((entry) => entry.ok).length,
      accounts: results,
      note: "Mailbox sync only. No email was sent.",
    },
  });
}