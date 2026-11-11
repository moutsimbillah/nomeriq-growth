import type { LeadModel } from "./model";

/**
 * What counts toward a research target ("100 new qualified leads"), per docs/lead-rules.md:
 * only Tier 1 and Other Signal Provider leads with verified paid-signal evidence, an official
 * email and no duplicate. Email-no-website, Category B, excluded and unassessed records are kept
 * as records but never counted.
 *
 * The tier and eligibility are the EFFECTIVE ones the lead-model reader shows: the latest
 * assessment (assessed_at, created_at, id — the same deterministic order as `getLeadModels` and
 * the lead-list projection) with the latest founder override per field winning. A later
 * downgrade therefore stops counting, and historical tier/eligibility overrides are honoured
 * exactly as stored. Nothing here writes or rewrites a historical record.
 *
 * Prospect-level conditions: not archived, not rejected by the founder (`qualification_status`
 * is the saved decision; the effective model, not that column, decides the tier), at least one
 * source-confirmed email (a founder-typed recipient is not an official published email), and
 * not currently marked "Duplicate of" another lead.
 */
export const QUALIFIED_TARGET_TIERS = ["tier_1", "other"] as const;

/** The model half of the rule, for parity checks against `getLeadModels`. */
export function isQualifiedTargetModel(model: Pick<LeadModel, "eligibility" | "tier">): boolean {
  return model.eligibility === "eligible" &&
    (QUALIFIED_TARGET_TIERS as readonly string[]).includes(model.tier ?? "");
}

const latestOverride = (alias: string, field: "eligibility" | "tier") => `(
      SELECT CASE WHEN o.decision = 'set' THEN o.value #>> '{}' END
      FROM prospect_assessment_overrides o
      WHERE o.prospect_id = ${alias}.id AND o.field_name = '${field}'
      ORDER BY o.decided_at DESC, o.id DESC LIMIT 1)`;

/**
 * The single SQL predicate every qualified-target reader uses, over one `prospects` row aliased
 * `alias`. It uses only EXISTS/scalar subqueries — never a join — so several emails, several
 * assessments or several overrides on one lead can never multiply that lead in a count.
 */
export function qualifiedTargetPredicateSql(alias = "p"): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("Invalid SQL alias for the qualified-target predicate.");
  return `(${alias}.archived_at IS NULL
    AND ${alias}.qualification_status <> 'rejected'
    AND EXISTS (SELECT 1 FROM prospect_emails qt_e
      WHERE qt_e.prospect_id = ${alias}.id AND qt_e.source_type <> 'founder_entered')
    AND NOT EXISTS (SELECT 1 FROM prospect_duplicate_links qt_d
      WHERE qt_d.prospect_id = ${alias}.id AND qt_d.restored_at IS NULL)
    AND EXISTS (
      SELECT 1 FROM (
        SELECT coalesce(ov.eligibility, la.eligibility, 'unknown') AS eligibility,
               coalesce(ov.tier, la.tier) AS tier
        FROM (SELECT ${latestOverride(alias, "eligibility")} AS eligibility,
                     ${latestOverride(alias, "tier")} AS tier) ov
        LEFT JOIN (
          SELECT a.eligibility, a.tier FROM prospect_assessments a
          WHERE a.prospect_id = ${alias}.id
          ORDER BY a.assessed_at DESC, a.created_at DESC, a.id DESC LIMIT 1
        ) la ON true
      ) qt_model
      WHERE qt_model.eligibility = 'eligible'
        AND qt_model.tier IN (${QUALIFIED_TARGET_TIERS.map(t => `'${t}'`).join(", ")})
    ))`;
}

/** Count of a research job's leads that count toward its target; `jobRef` is a SQL expression. */
export function qualifiedTargetCountSql(jobRef: string): string {
  return `(SELECT count(*) FROM prospects qt_p
    WHERE qt_p.research_job_id = ${jobRef} AND ${qualifiedTargetPredicateSql("qt_p")})`;
}
