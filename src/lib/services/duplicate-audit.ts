import { getDb, type DbClient } from "@/lib/db/client";

export interface DuplicatePair {
  prospectId: string;
  otherProspectId: string;
  reasons: string[];
}

/**
 * On-demand audit, never a scheduled job or automatic cleanup. Same resolver as saves.
 * Pairs are reported between canonical families: a lead the founder linked as a duplicate is
 * counted as its kept (canonical) lead, and a family is never reported against itself, so pairs
 * the founder already resolved drop out while an unrelated lead colliding with any family member
 * still appears (against the canonical lead).
 */
export async function scanProspectDuplicates(client?: DbClient): Promise<DuplicatePair[]> {
  const db = client ?? await getDb();
  const result = await db.query<{ prospect_id: string; other_prospect_id: string; reasons: string[] }>(`
    WITH matches AS (
      SELECT growth_identity_owner(p.id) AS prospect_id, m.prospect_id AS other_prospect_id, unnest(m.reasons) AS reason
      FROM prospects p
      CROSS JOIN LATERAL growth_find_identity_matches(
        ARRAY[p.domain_key],
        ARRAY(SELECT normalized_email FROM prospect_emails e WHERE e.prospect_id=p.id),
        ARRAY[p.name_key] || ARRAY(SELECT alias_key FROM prospect_aliases a WHERE a.prospect_id=p.id),
        ARRAY[p.instagram_key] || ARRAY(SELECT account_key FROM prospect_audience_observations a WHERE a.prospect_id=p.id AND platform='instagram'),
        ARRAY[p.youtube_key] || ARRAY(SELECT account_key FROM prospect_audience_observations a WHERE a.prospect_id=p.id AND platform='youtube'),
        ARRAY[p.x_key],
        ARRAY[p.telegram_key] || ARRAY(SELECT account_key FROM prospect_audience_observations a WHERE a.prospect_id=p.id AND platform='telegram'),
        CASE WHEN p.domain_key IS NULL THEN ARRAY[lower(regexp_replace(regexp_replace(split_part(p.website_url,'?',1),'^https?://(www\\.)?','','i'),'/$',''))] ELSE ARRAY[]::text[] END
        , p.id -- ignore only this lead's own founder-linked family
      ) m WHERE growth_identity_owner(p.id) <> m.prospect_id
    )
    SELECT least(prospect_id,other_prospect_id) AS prospect_id,
      greatest(prospect_id,other_prospect_id) AS other_prospect_id,
      array_agg(DISTINCT reason ORDER BY reason) AS reasons
    FROM matches GROUP BY 1,2 ORDER BY 1,2`);
  return result.rows.map(row => ({ prospectId: row.prospect_id, otherProspectId: row.other_prospect_id, reasons: row.reasons }));
}
