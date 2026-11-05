-- Pass D: lead content from the evidence, and the qualification rule. Counts and table names only.
BEGIN;

-- D0. carry-over: a suppression whose address belongs to an imported lead gets that lead
UPDATE suppressions s SET prospect_id = sub.prospect_id
  FROM (SELECT DISTINCT ON (e.normalized_email) e.normalized_email, e.prospect_id FROM prospect_emails e
         ORDER BY e.normalized_email, e.is_primary DESC) sub
 WHERE sub.normalized_email = s.normalized_email AND s.prospect_id IS NULL;

-- D1. the newest SIGNAL_SERVICE PASS finding is the lead's signal, with the contact source beside it
UPDATE prospects p SET
  signal_description = coalesce((
    SELECT e.data->>'finding' FROM stg.rows e JOIN stg.old_to_new om ON om.old_prospect_id = e.data->>'prospect_id'
     WHERE om.prospect_id = p.id AND e.source_table = 'marketing_prospect_evidence'
       AND e.data->>'kind' = 'SIGNAL_SERVICE' AND e.data->>'verdict' = 'PASS'
     ORDER BY (e.data->>'observed_at') DESC NULLS LAST, e.ordinal DESC LIMIT 1), p.signal_description),
  evidence_summary = left(concat_ws(' | ',
     nullif(left(coalesce((SELECT e.data->>'finding' FROM stg.rows e JOIN stg.old_to_new om ON om.old_prospect_id = e.data->>'prospect_id'
        WHERE om.prospect_id = p.id AND e.source_table = 'marketing_prospect_evidence'
          AND e.data->>'kind' = 'SIGNAL_SERVICE' AND e.data->>'verdict' = 'PASS'
        ORDER BY (e.data->>'observed_at') DESC NULLS LAST, e.ordinal DESC LIMIT 1), ''), 240), ''),
     nullif(left(coalesce((SELECT e.data->>'finding' FROM stg.rows e JOIN stg.old_to_new om ON om.old_prospect_id = e.data->>'prospect_id'
        WHERE om.prospect_id = p.id AND e.source_table = 'marketing_prospect_evidence'
          AND e.data->>'kind' = 'CONTACT'
        ORDER BY (e.data->>'observed_at') DESC NULLS LAST, e.ordinal DESC LIMIT 1), ''), 240), '')), 480)
 WHERE EXISTS (SELECT 1 FROM stg.old_to_new om WHERE om.prospect_id = p.id);

-- D2. every finding that carries a URL becomes a source, deduplicated per (lead, url) and against the
-- identity sources already imported. FAIL findings are kept, marked by their verdict in the notes.
INSERT INTO prospect_sources (id, prospect_id, url, label, source_type, observed_at, notes)
SELECT gen_random_uuid(), d.prospect_id, d.url, d.label, d.source_type, d.observed_at, d.notes
  FROM (SELECT DISTINCT ON (om.prospect_id, e.data->>'source_reference')
               om.prospect_id AS prospect_id, e.data->>'source_reference' AS url,
               coalesce(e.data->>'kind', 'evidence') AS label,
               CASE WHEN e.data->>'verdict' = 'FAIL' THEN 'public_profile' ELSE 'official_directory' END AS source_type,
               (e.data->>'observed_at')::timestamptz AS observed_at,
               left(concat_ws(' — ', nullif(e.data->>'verdict', ''),
                    nullif(left(coalesce(e.data->>'finding', ''), 200), '')), 400) AS notes
          FROM stg.rows e JOIN stg.old_to_new om ON om.old_prospect_id = e.data->>'prospect_id'
         WHERE e.source_table = 'marketing_prospect_evidence' AND (e.data->>'source_reference') LIKE 'http%'
         ORDER BY om.prospect_id, e.data->>'source_reference', e.ordinal) d
 WHERE NOT EXISTS (SELECT 1 FROM prospect_sources s WHERE s.prospect_id = d.prospect_id AND s.url = d.url);

-- D3. qualification: emailed leads are verified; a never-emailed lead only with an eligible market and an
-- official address carrying a VERIFIED check from a PUBLISHED_SOURCE. The 5 under review stay candidate.
UPDATE prospects p SET qualification_status = 'verified', updated_at = now()
 WHERE EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'outbound'
                 AND m.delivery_status IN ('accepted', 'uncertain'));

UPDATE prospects p SET qualification_status = 'verified', updated_at = now()
 WHERE p.qualification_status = 'candidate'
   AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'outbound'
                     AND m.delivery_status IN ('accepted', 'uncertain'))
   AND EXISTS (SELECT 1 FROM stg.rows sc JOIN stg.old_to_new om ON om.old_prospect_id = sc.data->>'prospect_id'
                WHERE om.prospect_id = p.id AND sc.source_table = 'marketing_prospect_signal_categories')
   AND NOT EXISTS (SELECT 1 FROM stg.rows er JOIN stg.old_to_new om ON om.old_prospect_id = er.data->>'prospect_id'
                    WHERE om.prospect_id = p.id AND er.source_table = 'marketing_eligibility_reviews'
                      AND er.data->>'state' = 'REVIEW_REQUIRED')
   AND EXISTS (SELECT 1 FROM stg.rows cc
                 JOIN stg.rows ct ON ct.source_table = 'marketing_prospect_contacts' AND ct.data->>'id' = cc.data->>'contact_id'
                 JOIN stg.old_to_new om ON om.old_prospect_id = cc.data->>'prospect_id'
                WHERE om.prospect_id = p.id AND cc.source_table = 'marketing_contact_checks'
                  AND cc.data->>'result' = 'VERIFIED' AND cc.data->>'method' = 'PUBLISHED_SOURCE'
                  AND ct.data->>'route' = 'EMAIL' AND ct.data->>'official_status' = 'OFFICIAL');
-- D4. a lead whose current assessment says NO, or whose brand risk is HIGH, is a candidate and never
-- followed up automatically, even though it was emailed. do_not_contact stays false: this is not a ban.
UPDATE prospects p SET qualification_status = 'candidate', follow_up_excluded = true, updated_at = now()
 WHERE EXISTS (SELECT 1 FROM stg.rows a JOIN stg.old_to_new om ON om.old_prospect_id = a.data->>'prospect_id'
                WHERE om.prospect_id = p.id AND a.source_table = 'marketing_qualification_assessments'
                  AND (a.data->>'qualification' = 'NO' OR a.data->>'brand_risk' = 'HIGH')
                  AND a.data->>'id' = (SELECT pr.data->>'current_assessment_id' FROM stg.rows pr
                                        WHERE pr.source_table = 'marketing_prospects'
                                          AND pr.data->>'id' = a.data->>'prospect_id'));
COMMIT;
