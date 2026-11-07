import type { LeadFilters } from "@/lib/leads/leadFilters";
import { FIT_POINTS, TIER_POINTS } from "@/lib/leads/model";

/** Scalar projection over p.id: reused by page, count and every facet before pagination.
 * Constants come from the policy module; parity tests compare it with the real model reader.
 * No join multiplies prospects and no cap is applied to the matching population.
 */
const projection = `WITH assessment AS (
  SELECT * FROM prospect_assessments WHERE prospect_id=p.id ORDER BY assessed_at DESC,created_at DESC,id DESC LIMIT 1
), overrides AS (
  SELECT coalesce(jsonb_object_agg(field_name,value) FILTER (WHERE decision='set'),'{}'::jsonb) AS v FROM (
    SELECT DISTINCT ON (field_name) field_name,decision,value FROM prospect_assessment_overrides
    WHERE prospect_id=p.id ORDER BY field_name,decided_at DESC,id DESC
  ) latest
), effective AS (
  SELECT a.id, a.assessed_at, coalesce(a.findings,'[]'::jsonb) AS findings,
    coalesce(o.v->'capability_gaps',a.capability_gaps,'[]'::jsonb) AS gaps, o.v AS overrides,
    coalesce(o.v->>'eligibility',a.eligibility,'unknown') AS eligibility,
    coalesce(o.v->>'tier',a.tier) AS raw_tier,
    coalesce(o.v->>'product_fit',a.product_fit,'unknown') AS fit
  FROM overrides o LEFT JOIN assessment a ON true
), model AS (
  SELECT *, CASE WHEN eligibility='excluded' OR raw_tier='excluded' THEN 'excluded' ELSE raw_tier END AS tier FROM effective
), audience AS (
  SELECT max(count_value) FILTER (WHERE count_state='verified' AND (platform IN ('instagram','youtube') OR
    platform='telegram' AND (SELECT tier FROM model) IN ('category_b','email_no_website'))) AS n FROM (
    SELECT DISTINCT ON (platform,account_key) platform,count_value,count_state FROM prospect_audience_observations
    WHERE prospect_id=p.id ORDER BY platform,account_key,checked_at DESC,created_at DESC,id DESC
  ) latest
), score AS (
 SELECT m.tier,m.fit,m.assessed_at,a.n AS audience,
   CASE WHEN m.tier='excluded' THEN NULL
     WHEN m.overrides ? 'priority_score' THEN (m.overrides->>'priority_score')::int
     WHEN m.id IS NULL OR m.tier IS NULL THEN NULL
     ELSE CASE m.fit WHEN 'high' THEN ${FIT_POINTS.high} WHEN 'medium' THEN ${FIT_POINTS.medium} WHEN 'low' THEN ${FIT_POINTS.low} ELSE ${FIT_POINTS.unknown} END
     + CASE m.tier WHEN 'tier_1' THEN ${TIER_POINTS.tier_1} WHEN 'other' THEN ${TIER_POINTS.other} WHEN 'email_no_website' THEN ${TIER_POINTS.email_no_website} ELSE 0 END
     + CASE WHEN a.n IS NULL THEN 0 WHEN a.n>=100000 THEN 8 WHEN a.n>=50000 THEN 6 WHEN a.n>=10000 THEN 4 WHEN a.n>=1000 THEN 2 ELSE 1 END
     + (SELECT count(DISTINCT f->>'area')::int FROM jsonb_array_elements(m.findings) f
        WHERE f->>'verdict'='present' AND f->>'area' IN ('paid_signals','markets','identity'))
     + CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(m.findings) f WHERE f->>'area'='email' AND f->>'verdict'='present') OR EXISTS(SELECT 1 FROM prospect_contact_route_observations r WHERE r.prospect_id=p.id AND r.official_status='verified') THEN 1 ELSE 0 END
     + CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(m.findings) f WHERE f->>'area' IN ('delivery','membership','dashboard','publishing','performance','payments') AND f->>'verdict'='present') THEN 1 ELSE 0 END
     + CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(m.findings) f WHERE f->>'area'='app') THEN 1 ELSE 0 END
     + CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(m.gaps) g WHERE g->>'area'='gap' AND g->>'verdict'='present')
         OR EXISTS(SELECT 1 FROM jsonb_array_elements(m.findings) f WHERE f->>'area'='gap' AND f->>'verdict'='present') THEN 1 ELSE 0 END
     + CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(m.findings) f WHERE f->>'area'='activity' AND f->>'verdict'='present' AND (f->>'activityAt')::timestamptz >= m.assessed_at-interval '30 days') THEN 5
       WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(m.findings) f WHERE f->>'area'='activity' AND f->>'verdict'='present' AND (f->>'activityAt')::timestamptz >= m.assessed_at-interval '90 days') THEN 3
       WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(m.findings) f WHERE f->>'area'='activity' AND f->>'verdict'='present') THEN 1 ELSE 0 END END AS priority
 FROM model m CROSS JOIN audience a
) SELECT * FROM score`;

export function leadModelConditions(filters: Pick<LeadFilters,"tier"|"productFit"|"minPriority"|"audience">, params: unknown[]): string {
  const conditions: string[]=[];
  const bind=(value:unknown)=>{params.push(value);return `$${params.length}`;};
  if(filters.tier==="unassessed")conditions.push("lm.tier IS NULL");
  else if(filters.tier)conditions.push(`lm.tier=${bind(filters.tier)}`);
  if(filters.tier!=="excluded")conditions.push("lm.tier IS DISTINCT FROM 'excluded'");
  if(filters.productFit)conditions.push(`lm.fit=${bind(filters.productFit)}`);
  if(filters.minPriority!==undefined)conditions.push(`lm.priority>=${bind(filters.minPriority)}`);
  if(filters.audience==="unknown")conditions.push("lm.audience IS NULL");
  else if(filters.audience!==undefined)conditions.push(`lm.audience>=${bind(filters.audience)}`);
  return `EXISTS (SELECT 1 FROM (${projection}) lm WHERE ${conditions.join(" AND ")})`;
}
export function leadPriorityOrderSql(): string {
  return `(SELECT priority FROM (${projection}) lm) DESC NULLS LAST,
    (SELECT CASE fit WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'unknown' THEN 2 ELSE 1 END FROM (${projection}) lm) DESC,
    (SELECT assessed_at FROM (${projection}) lm) DESC NULLS LAST,p.updated_at DESC,p.id`;
}
