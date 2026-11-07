import { getDb, type DbClient } from "@/lib/db/client";
import { AppError } from "@/lib/utils";

export interface LeadOutreachBlock { code: "alternative_contact_only" | "excluded_lead" | "unqualified_lead"; reason: string }

export function outreachBlockForTier(tier: string | null): LeadOutreachBlock | null {
  if (tier === "category_b") return { code: "alternative_contact_only", reason: "Category B is an alternative-contact research record. It cannot be emailed; adding an address alone does not re-qualify it." };
  if (tier === "excluded") return { code: "excluded_lead", reason: "This business is excluded from signal-provider outreach. Its research record is retained, but no email can be sent." };
  return null;
}

/**
 * Fail closed on known non-email tiers, including old approved/queued drafts and manually typed
 * recipients. An unassessed imported lead is not silently demoted. Existing recipient, suppression,
 * founder-approval, send-mode and daily-limit checks remain independently authoritative.
 */
export async function getLeadOutreachBlock(prospectId: string, client?: DbClient): Promise<LeadOutreachBlock | null> {
  const db = client ?? await getDb();
  const row = (await db.query<{ tier: string | null; assessment_id: string | null; eligibility: string }>(
    `SELECT (SELECT id FROM prospect_assessments WHERE prospect_id=$1 ORDER BY assessed_at DESC,created_at DESC,id DESC LIMIT 1) AS assessment_id,
      COALESCE((SELECT CASE WHEN decision='set' THEN value #>> '{}' ELSE NULL END FROM prospect_assessment_overrides WHERE prospect_id=$1 AND field_name='eligibility' ORDER BY decided_at DESC,id DESC LIMIT 1),
        (SELECT eligibility FROM prospect_assessments WHERE prospect_id=$1 ORDER BY assessed_at DESC,created_at DESC,id DESC LIMIT 1),'unknown') AS eligibility,
      COALESCE(
      (SELECT CASE WHEN o.decision = 'set' THEN o.value #>> '{}' ELSE NULL END
         FROM prospect_assessment_overrides o WHERE o.prospect_id = $1 AND o.field_name = 'tier'
         ORDER BY o.decided_at DESC, o.id DESC LIMIT 1),
      (SELECT a.tier FROM prospect_assessments a WHERE a.prospect_id = $1
         ORDER BY a.assessed_at DESC, a.created_at DESC, a.id DESC LIMIT 1)) AS tier`,
    [prospectId],
  )).rows[0];
  if (row?.eligibility === "excluded") return outreachBlockForTier("excluded");
  const block = outreachBlockForTier(row?.tier ?? null);
  if (block) return block;
  if (row?.assessment_id && (row.eligibility !== "eligible" || !row.tier)) return {code:"unqualified_lead",reason:"The new assessment has not verified the mandatory signal-seller requirements. Complete qualification before drafting or sending outreach."};
  return null;
}

export async function assertLeadOutreachAllowed(prospectId: string, client?: DbClient): Promise<void> {
  const block = await getLeadOutreachBlock(prospectId, client);
  if (block) throw new AppError(block.reason, 409, block.code);
}
