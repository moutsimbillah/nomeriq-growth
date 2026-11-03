import { getDb } from "@/lib/db/client";
import { iso, number } from "@/lib/utils";
import type { Classification, PipelineStatus } from "@/lib/types";
import { listConversations } from "./conversations";
import { listFollowUpCandidates, getFollowUpOverview } from "./followups";
import { listResearchJobs, getResearchOverview } from "./research";
import { listProspects } from "./prospects";
import { getProductTruth } from "./settings";
import { listEmailAccounts } from "@/lib/email/accounts";
import { getSyncHealth } from "@/lib/email/sync";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function getDashboardData() {
  const db = await getDb();
  const [
    counts,
    pipeline,
    recentConversations,
    recentProspects,
    jobs,
    researchOverview,
    followUps,
    candidates,
    accounts,
    truth,
    latestSent,
  ] = await Promise.all([
    db.query<any>(
      `SELECT
        (SELECT count(*) FROM prospects WHERE qualification_status = 'verified' AND archived_at IS NULL) AS verified,
        (SELECT count(*) FROM prospects WHERE qualification_status = 'verified' AND archived_at IS NULL
          AND EXISTS (SELECT 1 FROM prospect_emails e WHERE e.prospect_id = prospects.id)) AS verified_with_email,
        (SELECT count(*) FROM drafts WHERE status IN ('draft', 'approved')) AS drafts_open,
        (SELECT count(*) FROM drafts WHERE status = 'approved') AS drafts_approved,
        (SELECT count(*) FROM conversations WHERE unread_count > 0) AS unread_conversations,
        (SELECT count(*) FROM conversations WHERE last_inbound_at IS NOT NULL
          AND status IN ('replied', 'open')) AS replies_waiting,
        (SELECT count(*) FROM prospects WHERE status IN ('interested', 'demo', 'proposal') AND archived_at IS NULL) AS opportunities,
        (SELECT count(*) FROM prospects WHERE status = 'won' AND archived_at IS NULL) AS won,
        (SELECT count(*) FROM messages WHERE direction = 'outbound'
          AND COALESCE(sent_at, created_at) >= now() - interval '7 days') AS sent_week,
        (SELECT count(*) FROM messages WHERE direction = 'inbound'
          AND COALESCE(received_at, created_at) >= now() - interval '7 days') AS replies_week,
        (SELECT count(*) FROM prospects WHERE created_at >= now() - interval '7 days' AND archived_at IS NULL) AS new_week`,
    ),
    db.query<any>(
      `SELECT status, count(*) AS count FROM prospects
       WHERE archived_at IS NULL GROUP BY status`,
    ),
    listConversations({ onlyReplied: true, limit: 5 }),
    listProspects({ limit: 6 }),
    listResearchJobs(),
    getResearchOverview(),
    getFollowUpOverview(),
    listFollowUpCandidates(),
    listEmailAccounts(),
    getProductTruth(),
    db.query<any>(
      `SELECT m.subject, m.sent_at, m.is_sandbox, m.delivery_status,
        p.business_name, p.id AS prospect_id
       FROM messages m LEFT JOIN prospects p ON p.id = m.prospect_id
       WHERE m.direction = 'outbound'
       ORDER BY COALESCE(m.sent_at, m.created_at) DESC LIMIT 5`,
    ),
  ]);

  const countsRow = counts.rows[0] ?? {};
  const pipelineCounts = Object.fromEntries(
    pipeline.rows.map((row) => [row.status, number(row.count)]),
  ) as Record<PipelineStatus, number>;

  let syncHealth: Awaited<ReturnType<typeof getSyncHealth>> = [];
  if (accounts[0] && accounts[0].provider !== "sandbox") {
    syncHealth = await getSyncHealth(accounts[0].id).catch(() => []);
  }
  const hasIncompleteHistory = syncHealth.some(
    (state) => !state.historyComplete || state.error,
  );
  const lastSync = accounts[0]?.lastSyncAt;

  return {
    metrics: {
      verified: number(countsRow.verified),
      verifiedWithEmail: number(countsRow.verified_with_email),
      draftsOpen: number(countsRow.drafts_open),
      draftsApproved: number(countsRow.drafts_approved),
      unreadConversations: number(countsRow.unread_conversations),
      repliesWaiting: number(countsRow.replies_waiting),
      opportunities: number(countsRow.opportunities),
      won: number(countsRow.won),
      sentWeek: number(countsRow.sent_week),
      repliesWeek: number(countsRow.replies_week),
      newWeek: number(countsRow.new_week),
    },
    pipelineCounts,
    recentConversations,
    recentProspects,
    jobs,
    activeJob: jobs.find((job) => job.status === "active") ?? null,
    researchOverview,
    followUps: {
      ...followUps,
      dueCandidates: candidates.filter((candidate) => candidate.due).length,
    },
    account: accounts[0] ?? null,
    syncHealth,
    hasIncompleteHistory,
    lastSync,
    truth,
    latestSent: latestSent.rows.map((row) => ({
      subject: row.subject,
      sentAt: iso(row.sent_at),
      isSandbox: Boolean(row.is_sandbox),
      deliveryStatus: row.delivery_status,
      businessName: row.business_name,
      prospectId: row.prospect_id,
    })),
  };
}

export async function getUnreadConversationCount(): Promise<number> {
  const db = await getDb();
  const result = await db.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM conversations WHERE unread_count > 0`,
  );
  return number(result.rows[0]?.count);
}

export function classificationTone(classification: Classification): string {
  switch (classification) {
    case "interested":
    case "demo":
      return "lime";
    case "pricing":
      return "amber";
    case "not_interested":
    case "unsubscribe":
      return "rust";
    default:
      return "neutral";
  }
}
