import { getDb } from "@/lib/db/client";

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function exportWorkspaceBackup(): Promise<string> {
  const db = await getDb();
  const tables = [
    "workspace_settings",
    "product_truth",
    "product_truth_revisions",
    "research_jobs",
    "prospects",
    "prospect_aliases",
    "prospect_emails",
    "prospect_sources",
    "research_events",
    "drafts",
    "draft_revisions",
    "conversations",
    "messages",
    "message_attachments",
    "outbound_sends",
    "campaigns",
    "campaign_items",
    "suppressions",
    "unsubscribe_tokens",
  ];
  const data: Record<string, unknown[]> = {};
  for (const table of tables) {
    const result = await db.query<any>(`SELECT * FROM ${table}`);
    data[table] = result.rows.map((row) => {
      if (table === "message_attachments" && row.content) {
        return { ...row, content: "[binary omitted from JSON export]" };
      }
      return row;
    });
  }
  return JSON.stringify(
    {
      schema: "nomeriq-growth-v1",
      exportedAt: new Date().toISOString(),
      note:
        "Secrets are excluded: no password hashes, sessions, API key hashes, encrypted mailbox credentials or users are in this export.",
      tables: data,
    },
    null,
    2,
  );
}
