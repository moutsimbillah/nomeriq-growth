import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/utils";
import type { PipelineStatus } from "@/lib/types";

/**
 * Stages the founder sets by hand — from the folder inbox's stage buttons now, and the pipeline
 * board's click or drag later. Research, Outreach, Follow-up and Engaged move automatically from
 * recorded facts; these are the decisions only the founder makes. Every change is audited.
 */
export const FOUNDER_STAGES = ["interested", "demo", "proposal", "won", "lost"] as const satisfies readonly PipelineStatus[];
export type FounderStage = (typeof FOUNDER_STAGES)[number];

export const FOUNDER_STAGE_LABELS: Record<FounderStage, string> = {
  interested: "Interested",
  demo: "Demo",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
};

/** Where a move came from, kept in the audit entry. */
export const STAGE_MOVE_SOURCES = ["stage_buttons", "board_click", "board_drag"] as const;
export type StageMoveSource = (typeof STAGE_MOVE_SOURCES)[number];

export function isFounderStage(value: unknown): value is FounderStage {
  return typeof value === "string" && (FOUNDER_STAGES as readonly string[]).includes(value);
}

export async function setLeadStage(
  prospectId: string,
  stage: FounderStage,
  userId: string,
  via: StageMoveSource = "stage_buttons",
): Promise<{ from: string; to: FounderStage; changed: boolean }> {
  if (!isFounderStage(stage)) throw new AppError("That stage is not one you set by hand.", 400);
  const db = await getDb();
  return db.transaction(async (tx) => {
    const current = await tx.query<{ status: string; archived_at: string | null }>(
      `SELECT status, archived_at FROM prospects WHERE id = $1 FOR UPDATE`,
      [prospectId],
    );
    const row = current.rows[0];
    if (!row) throw new AppError("Lead not found.", 404);
    if (row.archived_at) throw new AppError("This lead is archived. Restore it before changing its stage.", 409);
    if (row.status === stage) return { from: row.status, to: stage, changed: false };
    await tx.query(`UPDATE prospects SET status = $2, updated_at = now() WHERE id = $1`, [prospectId, stage]);
    await tx.query(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'founder', $2, 'lead.stage_changed', 'prospect', $3, $4::jsonb)`,
      [crypto.randomUUID(), userId, prospectId, JSON.stringify({ from: row.status, to: stage, via })],
    );
    return { from: row.status, to: stage, changed: true };
  });
}
