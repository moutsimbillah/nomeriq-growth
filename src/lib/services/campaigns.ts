import { getDb } from "@/lib/db/client";
import { AppError, iso } from "@/lib/utils";
import type { CampaignSummary, Draft } from "@/lib/types";
import { getEmailAccountRecord } from "@/lib/email/accounts";
import { getDraft } from "./drafts";
import { sendDraft } from "./email-sending";
import { getSendUsage } from "./email-sending";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function createCampaign(input: {
  name: string;
  draftIds: string[];
  accountId: string;
  userId: string;
  authorize: boolean;
}): Promise<{ id: string }> {
  if (!input.name.trim()) throw new AppError("Give the campaign a name.");
  if (!input.draftIds.length) throw new AppError("Select at least one approved draft.");
  if (!input.authorize) {
    throw new AppError(
      "Explicit founder authorization is required before a campaign can be queued.",
      400,
      "authorization_required",
    );
  }
  const account = await getEmailAccountRecord(input.accountId);
  if (!account) throw new AppError("Email account not found.", 404);
  if (account.status !== "connected") {
    throw new AppError(
      "Connect a healthy email account before creating a campaign.",
      409,
    );
  }
  const uniqueDraftIds = [...new Set(input.draftIds)];
  const drafts: Draft[] = [];
  for (const draftId of uniqueDraftIds) {
    const draft = await getDraft(draftId);
    if (!draft) throw new AppError("One of the selected drafts no longer exists.");
    if (draft.kind !== "first_contact") {
      throw new AppError(
        "Campaigns send first-contact drafts. Follow-ups are reviewed individually.",
      );
    }
    if (draft.status !== "approved") {
      throw new AppError("Every campaign draft must be approved first.");
    }
    drafts.push(draft);
  }

  const db = await getDb();
  const id = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO campaigns
        (id, name, status, account_id, created_by, approved_by, approved_at,
         daily_send_limit_snapshot, min_interval_snapshot)
       VALUES ($1, $2, 'approved', $3, $4, $4, now(), $5, $6)`,
      [
        id,
        input.name.trim(),
        input.accountId,
        input.userId,
        account.dailySendLimit,
        account.minIntervalSeconds,
      ],
    );
    let position = 0;
    for (const draft of drafts) {
      await tx.query(
        `INSERT INTO campaign_items
          (id, campaign_id, prospect_id, draft_id, position, status)
         VALUES ($1, $2, $3, $4, $5, 'queued')`,
        [
          crypto.randomUUID(),
          id,
          draft.prospectId,
          draft.id,
          position,
        ],
      );
      position += 1;
    }
    await tx.query(
      `INSERT INTO audit_log
        (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'founder', $2, 'campaign.created', 'campaign', $3, $4::jsonb)`,
      [
        crypto.randomUUID(),
        input.userId,
        id,
        JSON.stringify({ name: input.name, drafts: drafts.length }),
      ],
    );
  });
  return { id };
}

export async function startCampaign(id: string, userId: string): Promise<void> {
  const db = await getDb();
  const result = await db.query(
    `UPDATE campaigns SET status = 'active', updated_at = now()
     WHERE id = $1 AND status = 'approved'`,
    [id],
  );
  if (!result.rowCount) {
    throw new AppError(
      "Only an approved, unstarted campaign can be started.",
      409,
    );
  }
  await db.query(
    `INSERT INTO audit_log
      (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, 'founder', $2, 'campaign.started', 'campaign', $3, '{}'::jsonb)`,
    [crypto.randomUUID(), userId, id],
  );
}

export async function setCampaignStatus(
  id: string,
  status: "paused" | "active" | "cancelled",
): Promise<void> {
  if (status === "cancelled") {
    const db = await getDb();
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE campaigns SET status = 'cancelled', updated_at = now() WHERE id = $1`,
        [id],
      );
      await tx.query(
        `UPDATE campaign_items SET status = 'skipped', updated_at = now()
         WHERE campaign_id = $1 AND status = 'queued'`,
        [id],
      );
    });
    return;
  }
  const db = await getDb();
  await db.query(
    `UPDATE campaigns SET status = $1, updated_at = now()
     WHERE id = $2 AND status IN ('approved', 'paused', 'active')`,
    [status, id],
  );
}

export async function renameCampaign(id: string, name: string): Promise<void> {
  if (!name.trim()) throw new AppError("Campaign name cannot be empty.");
  const db = await getDb();
  const result = await db.query(
    `UPDATE campaigns SET name = $1, updated_at = now() WHERE id = $2`,
    [name.trim(), id],
  );
  if (!result.rowCount) throw new AppError("Campaign not found.", 404);
}

export async function listCampaigns(): Promise<CampaignSummary[]> {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT c.*, a.email_address,
      (SELECT count(*) FROM campaign_items ci WHERE ci.campaign_id = c.id) AS total,
      (SELECT count(*) FROM campaign_items ci WHERE ci.campaign_id = c.id AND ci.status = 'sent') AS sent,
      (SELECT count(*) FROM campaign_items ci WHERE ci.campaign_id = c.id AND ci.status = 'failed') AS failed,
      (SELECT count(*) FROM campaign_items ci WHERE ci.campaign_id = c.id AND ci.status IN ('queued', 'sending')) AS queued
     FROM campaigns c
     JOIN email_accounts a ON a.id = c.account_id
     ORDER BY c.created_at DESC LIMIT 100`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    accountEmail: row.email_address,
    total: Number(row.total),
    sent: Number(row.sent),
    failed: Number(row.failed),
    queued: Number(row.queued),
    createdAt: iso(row.created_at) ?? "",
  }));
}

export async function getCampaign(id: string) {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT c.*, a.email_address FROM campaigns c
     JOIN email_accounts a ON a.id = c.account_id WHERE c.id = $1`,
    [id],
  );
  const campaign = result.rows[0];
  if (!campaign) return null;
  const items = await db.query<any>(
    `SELECT ci.*, p.business_name, d.subject
     FROM campaign_items ci
     JOIN prospects p ON p.id = ci.prospect_id
     JOIN drafts d ON d.id = ci.draft_id
     WHERE ci.campaign_id = $1 ORDER BY ci.position ASC`,
    [id],
  );
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    accountEmail: campaign.email_address,
    total: items.rows.length,
    sent: items.rows.filter((item) => item.status === "sent").length,
    failed: items.rows.filter((item) => item.status === "failed").length,
    queued: items.rows.filter((item) => ["queued", "sending"].includes(item.status)).length,
    createdAt: iso(campaign.created_at),
    items: items.rows.map((item) => ({
      id: item.id,
      prospectId: item.prospect_id,
      businessName: item.business_name,
      subject: item.subject,
      status: item.status,
      error: item.error,
    })),
    usage: await getSendUsage(campaign.account_id),
  };
}

export async function processNextCampaignItem(
  campaignId: string,
  userId: string,
): Promise<{
  done: boolean;
  sent?: boolean;
  error?: string;
  message?: string;
  nextAllowedAt?: string | null;
  progress?: { sent: number; failed: number; queued: number; total: number };
}> {
  const db = await getDb();
  const campaign = await db.query<any>(
    `SELECT * FROM campaigns WHERE id = $1`,
    [campaignId],
  );
  const row = campaign.rows[0];
  if (!row) throw new AppError("Campaign not found.", 404);
  if (row.status !== "active") {
    throw new AppError("This campaign is not active.", 409);
  }

  let item: any = null;
  await db.transaction(async (tx) => {
    const next = await tx.query<any>(
      `SELECT ci.*, d.status AS draft_status
       FROM campaign_items ci
       JOIN drafts d ON d.id = ci.draft_id
       WHERE ci.campaign_id = $1 AND ci.status = 'queued'
       ORDER BY ci.position ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [campaignId],
    );
    item = next.rows[0] ?? null;
    if (item) {
      await tx.query(
        `UPDATE campaign_items SET status = 'sending', updated_at = now() WHERE id = $1`,
        [item.id],
      );
    }
  });

  if (!item) {
    await db.query(
      `UPDATE campaigns SET status = 'completed', completed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'active'`,
      [campaignId],
    );
    return { done: true };
  }

  try {
    const outcome = await sendDraft({
      draftId: item.draft_id,
      accountId: row.account_id,
      campaignId,
      actorUserId: userId,
    });
    if ("queued" in outcome) {
      // Held back by the account's own minimum interval. Nothing was sent, so the item returns to the
      // queue and the runner can take it again once the window passes.
      await db.query(
        `UPDATE campaign_items SET status = 'queued', error = null, updated_at = now() WHERE id = $1`,
        [item.id],
      );
      const usage = await getSendUsage(row.account_id);
      return {
        done: false,
        sent: false,
        error: undefined,
        nextAllowedAt: usage.nextAllowedAt,
        progress: await campaignProgress(campaignId),
      };
    }
    const progress = await campaignProgress(campaignId);
    if (progress.queued === 0) {
      await db.query(
        `UPDATE campaigns SET status = 'completed', completed_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'active'`,
        [campaignId],
      );
    }
    return {
      done: progress.queued === 0,
      sent: true,
      progress,
    };
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    if (
      appError &&
      ["min_interval", "daily_limit_reached"].includes(appError.code)
    ) {
      await db.query(
        `UPDATE campaign_items SET status = 'queued', updated_at = now() WHERE id = $1`,
        [item.id],
      );
      const usage = await getSendUsage(row.account_id);
      const progress = await campaignProgress(campaignId);
      return {
        done: false,
        sent: false,
        error: appError.message,
        nextAllowedAt: usage.nextAllowedAt,
        progress,
      };
    }
    const message =
      error instanceof Error ? error.message : "The campaign item failed.";
    await db.query(
      `UPDATE campaign_items SET status = 'failed', error = $1, updated_at = now()
       WHERE id = $2`,
      [message, item.id],
    );
    if (
      appError?.code === "suppressed" ||
      appError?.code === "already_contacted" ||
      appError?.code === "prospect_replied"
    ) {
      await db.query(
        `UPDATE campaign_items SET status = 'skipped', error = $1, updated_at = now()
         WHERE id = $2`,
        [message, item.id],
      );
    }
    const progress = await campaignProgress(campaignId);
    if (progress.queued === 0) {
      await db.query(
        `UPDATE campaigns SET status = 'completed', completed_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'active'`,
        [campaignId],
      );
    }
    return { done: progress.queued === 0, sent: false, error: message, progress };
  }
}

export async function retryFailedCampaignItems(
  campaignId: string,
): Promise<{ queued: number; uncertain: number }> {
  const db = await getDb();
  const campaign = await db.query<any>(`SELECT * FROM campaigns WHERE id = $1`, [
    campaignId,
  ]);
  if (!campaign.rows[0]) throw new AppError("Campaign not found.", 404);
  const failed = await db.query<any>(
    `SELECT ci.id, os.status AS send_status
     FROM campaign_items ci
     LEFT JOIN outbound_sends os ON os.draft_id = ci.draft_id
     WHERE ci.campaign_id = $1 AND ci.status = 'failed'`,
    [campaignId],
  );
  let queued = 0;
  let uncertain = 0;
  await db.transaction(async (tx) => {
    for (const item of failed.rows) {
      if (item.send_status === "uncertain") {
        uncertain += 1;
        continue;
      }
      await tx.query(
        `UPDATE campaign_items SET status = 'queued', error = null, updated_at = now()
         WHERE id = $1`,
        [item.id],
      );
      queued += 1;
    }
    if (queued > 0) {
      await tx.query(
        `UPDATE campaigns SET status = 'active', completed_at = null, updated_at = now()
         WHERE id = $1`,
        [campaignId],
      );
    }
  });
  return { queued, uncertain };
}

export async function campaignProgress(campaignId: string) {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT
      count(*) AS total,
      count(*) FILTER (WHERE status = 'sent') AS sent,
      count(*) FILTER (WHERE status = 'failed') AS failed,
      count(*) FILTER (WHERE status = 'skipped') AS skipped,
      count(*) FILTER (WHERE status IN ('queued', 'sending')) AS queued
     FROM campaign_items WHERE campaign_id = $1`,
    [campaignId],
  );
  const row = result.rows[0];
  return {
    total: Number(row.total),
    sent: Number(row.sent),
    failed: Number(row.failed),
    skipped: Number(row.skipped),
    queued: Number(row.queued),
  };
}
