-- Pass A: suppressions, the 6 merge groups, leads, emails, sources, aliases, sender pins.
-- Reads stg.rows and stg.decisions; writes the portal's own tables. Counts, names and codes only in the log.
BEGIN;

-- ------------------------------------------------- A1. the 57 permanent failures
INSERT INTO suppressions (id, normalized_email, email, reason, source, note, active)
SELECT gen_random_uuid(), lower(n.data->>'recipient'), lower(n.data->>'recipient'), 'bounce',
       'legacy_import', 'permanent failure recorded by the old portal', true
  FROM stg.rows n
 WHERE n.source_table = 'marketing_email_delivery_notices' AND coalesce(n.data->>'recipient', '') <> ''
   AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.normalized_email = lower(n.data->>'recipient'));

-- ------------------------------------------------- A2. one row per old lead, resolved
DROP TABLE IF EXISTS stg.lead;
CREATE TABLE stg.lead AS
SELECT r.data->>'id' AS old_prospect_id,
       r.ordinal AS ordinal,
       btrim(r.data->>'display_name') AS business_name,
       lower(trim(both '-' from regexp_replace(btrim(r.data->>'display_name'), '[^a-zA-Z0-9]+', '-', 'g'))) AS name_key,
       coalesce(r.data->>'pipeline', 'RESEARCH') AS pipeline,
       coalesce((SELECT o.data->>'disposition' FROM stg.rows o
                  WHERE o.source_table = 'marketing_opportunities' AND o.data->>'prospect_id' = r.data->>'id'
                  LIMIT 1), 'OPEN') AS disposition,
       EXISTS (SELECT 1 FROM stg.rows t WHERE t.source_table = 'marketing_pipeline_transitions'
                 AND t.data->>'prospect_id' = r.data->>'id'
                 AND t.data->>'to_stage' IN ('OUTREACH', 'ENGAGED', 'CLOSED')) AS contacted,
       (SELECT t.data->>'occurred_at' FROM stg.rows t WHERE t.source_table = 'marketing_pipeline_transitions'
          AND t.data->>'prospect_id' = r.data->>'id' AND t.data->>'to_stage' = 'OUTREACH'
          ORDER BY t.data->>'occurred_at' LIMIT 1) AS contacted_at,
       (SELECT sc.data->>'research_client' FROM stg.rows sc
          WHERE sc.source_table = 'marketing_prospect_signal_categories' AND sc.data->>'prospect_id' = r.data->>'id'
          ORDER BY sc.ordinal DESC LIMIT 1) AS research_client,
       (SELECT CASE WHEN jsonb_typeof(sc.data->'categories') = 'array'
                      THEN (SELECT jsonb_agg(e ORDER BY e) FROM jsonb_array_elements_text(sc.data->'categories') e
                             WHERE upper(e) NOT IN ('STOCKS', 'OPTIONS'))
                    WHEN jsonb_typeof(sc.data->'categories') = 'object'
                      THEN (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(sc.data->'categories') k
                             WHERE upper(k) NOT IN ('STOCKS', 'OPTIONS'))
                    ELSE '[]'::jsonb END
          FROM stg.rows sc WHERE sc.source_table = 'marketing_prospect_signal_categories'
            AND sc.data->>'prospect_id' = r.data->>'id' ORDER BY sc.ordinal DESC LIMIT 1) AS categories,
       (SELECT au.data->>'parsed_count' FROM stg.rows au WHERE au.source_table = 'marketing_prospect_audience_snapshots'
          AND au.data->>'prospect_id' = r.data->>'id' AND au.data->>'count_kind' = 'FOLLOWERS'
          ORDER BY au.data->>'observed_at' DESC LIMIT 1) AS followers,
       (SELECT au.data->>'parsed_count' FROM stg.rows au WHERE au.source_table = 'marketing_prospect_audience_snapshots'
          AND au.data->>'prospect_id' = r.data->>'id' AND au.data->>'count_kind' = 'SUBSCRIBERS'
          ORDER BY au.data->>'observed_at' DESC LIMIT 1) AS subscribers,
       (SELECT i.data->>'canonical_key' FROM stg.rows i WHERE i.source_table = 'marketing_prospect_identities'
          AND i.data->>'prospect_id' = r.data->>'id' AND i.data->>'authority' = 'domain'
          AND i.data->>'status' IN ('VERIFIED', 'PROPOSED') ORDER BY i.ordinal LIMIT 1) AS domain_key,
       (SELECT i.data->>'canonical_key' FROM stg.rows i WHERE i.source_table = 'marketing_prospect_identities'
          AND i.data->>'prospect_id' = r.data->>'id' AND i.data->>'authority' = 'instagram'
          AND i.data->>'status' IN ('VERIFIED', 'PROPOSED') ORDER BY i.ordinal LIMIT 1) AS instagram_key,
       (SELECT i.data->>'canonical_key' FROM stg.rows i WHERE i.source_table = 'marketing_prospect_identities'
          AND i.data->>'prospect_id' = r.data->>'id' AND i.data->>'authority' = 'youtube'
          AND i.data->>'status' IN ('VERIFIED', 'PROPOSED') AND i.data->>'canonical_key' LIKE 'UC%'
          ORDER BY i.ordinal LIMIT 1) AS youtube_key,
       (SELECT i.data->>'canonical_key' FROM stg.rows i WHERE i.source_table = 'marketing_prospect_identities'
          AND i.data->>'prospect_id' = r.data->>'id' AND i.data->>'authority' = 'x'
          AND i.data->>'status' IN ('VERIFIED', 'PROPOSED') ORDER BY i.ordinal LIMIT 1) AS x_key,
       (SELECT i.data->>'canonical_key' FROM stg.rows i WHERE i.source_table = 'marketing_prospect_identities'
          AND i.data->>'prospect_id' = r.data->>'id' AND i.data->>'authority' = 'telegram'
          AND i.data->>'status' IN ('VERIFIED', 'PROPOSED') ORDER BY i.ordinal LIMIT 1) AS telegram_key
  FROM stg.rows r WHERE r.source_table = 'marketing_prospects';

-- ------------------------------------------------- A3. the 6 merge groups: 12 records, 6 leads
-- From import-decisions.json, applied before any collision is considered: the kept domain wins and the
-- folded domain is kept as an alias on other_socials and in the notes.
CREATE TABLE stg.old_to_lead (old_prospect_id text PRIMARY KEY, lead_old_id text NOT NULL);
INSERT INTO stg.old_to_lead SELECT old_prospect_id, old_prospect_id FROM stg.lead;

CREATE TABLE stg.merge_group (business text, kept_old_id text, folded_old_id text, folded_domain text);
INSERT INTO stg.merge_group
SELECT g.data->>'business',
       (SELECT l.old_prospect_id FROM stg.lead l WHERE l.domain_key = g.data->>'kept_domain' LIMIT 1),
       ids.value #>> '{}',
       (SELECT l.domain_key FROM stg.lead l WHERE l.old_prospect_id = (ids.value #>> '{}') LIMIT 1)
  FROM (SELECT data FROM stg.decisions) dec,
       jsonb_array_elements(dec.data->'merge_on_import_only') AS g(data),
       jsonb_array_elements(g.data->'source_prospect_ids') AS ids(value)
 WHERE jsonb_typeof(ids.value) = 'string'
   AND (ids.value #>> '{}') IS DISTINCT FROM
       (SELECT l.old_prospect_id FROM stg.lead l WHERE l.domain_key = g.data->>'kept_domain' LIMIT 1);

UPDATE stg.old_to_lead m SET lead_old_id = g.kept_old_id
  FROM stg.merge_group g WHERE m.old_prospect_id = g.folded_old_id AND g.kept_old_id IS NOT NULL;

-- the surviving lead carries the group's history
UPDATE stg.lead k SET contacted = grp.contacted, contacted_at = grp.contacted_at
  FROM (SELECT m.lead_old_id, bool_or(x.contacted) AS contacted, min(x.contacted_at) AS contacted_at
          FROM stg.old_to_lead m JOIN stg.lead x ON x.old_prospect_id = m.old_prospect_id
         WHERE m.old_prospect_id <> m.lead_old_id GROUP BY 1) grp
 WHERE k.old_prospect_id = grp.lead_old_id;

CREATE TABLE stg.merged_away (old_prospect_id text, kept_old_id text, kept_domain text, folded_domain text,
                              business text);
INSERT INTO stg.merged_away
SELECT m.old_prospect_id, m.lead_old_id, k.domain_key, l.domain_key, m.lead_old_id
  FROM stg.old_to_lead m JOIN stg.lead l ON l.old_prospect_id = m.old_prospect_id
  JOIN stg.lead k ON k.old_prospect_id = m.lead_old_id
 WHERE m.old_prospect_id <> m.lead_old_id;
UPDATE stg.merged_away ma SET business = (SELECT l.business_name FROM stg.lead l WHERE l.old_prospect_id = ma.kept_old_id);

DELETE FROM stg.lead WHERE old_prospect_id IN (SELECT old_prospect_id FROM stg.merged_away);

-- ------------------------------------------------- A4. a key is claimed once, after the merges
CREATE TABLE stg.demoted (old_prospect_id text, authority text, key text, rule text);
DO $do$
DECLARE col text;
BEGIN
  FOREACH col IN ARRAY ARRAY['domain_key', 'instagram_key', 'youtube_key', 'x_key', 'telegram_key'] LOOP
    EXECUTE format('INSERT INTO stg.demoted SELECT old_prospect_id, %L, %I, ''duplicate-in-import'' '
                   'FROM stg.lead l WHERE %I IS NOT NULL AND EXISTS '
                   '(SELECT 1 FROM stg.lead o WHERE o.%I = l.%I AND o.ordinal < l.ordinal)', col, col, col, col, col);
    EXECUTE format('UPDATE stg.lead l SET %I = NULL WHERE %I IS NOT NULL AND EXISTS '
                   '(SELECT 1 FROM stg.lead o WHERE o.%I = l.%I AND o.ordinal < l.ordinal)', col, col, col, col);
    EXECUTE format('INSERT INTO stg.demoted SELECT old_prospect_id, %L, %I, ''already-held'' '
                   'FROM stg.lead WHERE %I IS NOT NULL AND EXISTS (SELECT 1 FROM prospects x WHERE x.%I = stg.lead.%I)',
                   col, col, col, col, col);
    EXECUTE format('UPDATE stg.lead SET %I = NULL WHERE %I IS NOT NULL AND EXISTS '
                   '(SELECT 1 FROM prospects x WHERE x.%I = stg.lead.%I)', col, col, col, col);
  END LOOP;
END $do$;

ALTER TABLE stg.lead ADD COLUMN status text;
UPDATE stg.lead SET status = CASE WHEN disposition = 'LOST' THEN 'lost' WHEN contacted THEN 'contacted' ELSE 'new' END;
ALTER TABLE stg.lead ADD COLUMN profile_id uuid;
ALTER TABLE stg.lead ADD COLUMN pinned_at timestamptz;
UPDATE stg.lead SET profile_id = (SELECT id FROM email_accounts WHERE normalized_email = 'moutsim@nomeriq.com'),
                    pinned_at = CASE WHEN contacted THEN coalesce((contacted_at)::timestamptz, now()) END
 WHERE contacted;

-- ------------------------------------------------- A5. fold what is already here, identity first
UPDATE prospects p SET status = l.status,
       sending_profile_id = coalesce(l.profile_id, p.sending_profile_id),
       sending_profile_pinned_at = coalesce(l.pinned_at, p.sending_profile_pinned_at),
       metadata = coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object('legacy', jsonb_build_object(
                    'prospect_id', l.old_prospect_id, 'pipeline', l.pipeline, 'disposition', l.disposition)),
       updated_at = now()
  FROM stg.lead l
 WHERE (l.domain_key IS NOT NULL AND l.domain_key = p.domain_key)
    OR (l.instagram_key IS NOT NULL AND l.instagram_key = p.instagram_key)
    OR (l.youtube_key IS NOT NULL AND l.youtube_key = p.youtube_key)
    OR (l.x_key IS NOT NULL AND l.x_key = p.x_key)
    OR (l.telegram_key IS NOT NULL AND l.telegram_key = p.telegram_key)
    OR regexp_replace(lower(l.business_name), '[^a-z0-9]', '', 'g')
       = regexp_replace(lower(btrim(p.business_name)), '[^a-z0-9]', '', 'g');

INSERT INTO prospects (id, business_name, name_key, country, categories, follower_count, subscriber_count,
                       qualification_status, status, created_by_type, source_channel, source_agent,
                       sending_profile_id, sending_profile_pinned_at, last_contacted_at, website_url, domain_key,
                       instagram_key, youtube_key, x_key, telegram_key, other_socials, metadata, do_not_contact,
                       created_at, updated_at)
SELECT gen_random_uuid(), l.business_name, l.name_key, 'Unknown', coalesce(l.categories, '[]'::jsonb),
       l.followers, l.subscribers, 'candidate', l.status, 'legacy', 'legacy_import',
       CASE upper(coalesce(l.research_client, '')) WHEN 'CLAUDE' THEN 'claude' WHEN 'CHATGPT' THEN 'chatgpt'
                                                   ELSE 'unknown' END,
       l.profile_id, l.pinned_at, (l.contacted_at)::timestamptz,
       CASE WHEN l.domain_key IS NOT NULL THEN 'https://' || l.domain_key END, l.domain_key,
       l.instagram_key, l.youtube_key, l.x_key, l.telegram_key,
       coalesce((SELECT jsonb_agg(jsonb_build_object('kind', 'merged-domain', 'domain', ma.folded_domain,
                                                     'note', 'folded into this lead on import'))
                   FROM stg.merged_away ma WHERE ma.kept_old_id = l.old_prospect_id), '[]'::jsonb),
       jsonb_build_object('legacy', jsonb_build_object('prospect_id', l.old_prospect_id, 'pipeline', l.pipeline,
            'disposition', l.disposition)),
       l.disposition = 'LOST', now(), now()
  FROM stg.lead l
 WHERE NOT EXISTS (SELECT 1 FROM prospects p
                    WHERE (l.domain_key IS NOT NULL AND l.domain_key = p.domain_key)
                       OR regexp_replace(lower(l.business_name), '[^a-z0-9]', '', 'g')
                          = regexp_replace(lower(btrim(p.business_name)), '[^a-z0-9]', '', 'g'));

-- ------------------------------------------------- A6. emails, sources, other socials, aliases
CREATE VIEW stg.lead_of AS
SELECT m.old_prospect_id, p.id AS prospect_id FROM stg.old_to_lead m
  JOIN prospects p ON coalesce(p.metadata->'legacy'->>'prospect_id', '') = m.lead_old_id;

INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type, is_primary)
SELECT gen_random_uuid(), d.prospect_id, d.email, d.normalized_email, d.source_url, d.source_type,
       row_number() OVER (PARTITION BY d.prospect_id ORDER BY d.ordinal) = 1
  FROM (SELECT DISTINCT ON (lower(coalesce(c.data->>'normalized_locator', c.data->>'locator')))
               lo.prospect_id, c.data->>'locator' AS email,
               lower(coalesce(c.data->>'normalized_locator', c.data->>'locator')) AS normalized_email,
               c.data->>'source_reference' AS source_url,
               CASE WHEN c.data->>'official_status' = 'OFFICIAL' THEN 'official_website' ELSE 'public_profile' END AS source_type,
               c.ordinal
          FROM stg.rows c JOIN stg.lead_of lo ON lo.old_prospect_id = c.data->>'prospect_id'
         WHERE c.source_table = 'marketing_prospect_contacts' AND c.data->>'route' = 'EMAIL'
           AND coalesce(c.data->>'locator', '') LIKE '%@%'
         ORDER BY lower(coalesce(c.data->>'normalized_locator', c.data->>'locator')), c.ordinal) d
 WHERE NOT EXISTS (SELECT 1 FROM prospect_emails e WHERE e.normalized_email = d.normalized_email);

INSERT INTO prospect_sources (id, prospect_id, url, label, source_type, observed_at, notes)
SELECT gen_random_uuid(), lo.prospect_id,
       CASE WHEN i.data->>'authority' = 'domain' THEN 'https://' || (i.data->>'canonical_key')
            WHEN i.data->>'authority' = 'youtube' THEN 'https://youtube.com/channel/' || (i.data->>'canonical_key')
            WHEN i.data->>'authority' = 'instagram' THEN 'https://instagram.com/' || (i.data->>'canonical_key')
            WHEN i.data->>'authority' = 'telegram' THEN 'https://t.me/' || (i.data->>'canonical_key')
            WHEN i.data->>'authority' = 'x' THEN 'https://x.com/' || (i.data->>'canonical_key')
            ELSE (i.data->>'canonical_key') END,
       initcap(i.data->>'authority'), 'official_website', (i.data->>'created_at')::timestamptz,
       'old portal identity, ' || (i.data->>'status')
  FROM stg.rows i JOIN stg.lead_of lo ON lo.old_prospect_id = i.data->>'prospect_id'
 WHERE i.source_table = 'marketing_prospect_identities' AND i.data->>'status' IN ('VERIFIED', 'PROPOSED');

UPDATE prospects p SET other_socials = coalesce(p.other_socials, '[]'::jsonb) || (
         SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM (
           SELECT jsonb_build_object('kind', 'route', 'route', c.data->>'route', 'locator', c.data->>'locator',
                                     'official', c.data->>'official_status') AS x
             FROM stg.rows c JOIN stg.lead_of lo ON lo.old_prospect_id = c.data->>'prospect_id'
            WHERE c.source_table = 'marketing_prospect_contacts' AND c.data->>'route' <> 'EMAIL'
              AND lo.prospect_id = p.id
           UNION ALL
           SELECT jsonb_build_object('kind', 'identity', 'authority', i.data->>'authority',
                                     'key', i.data->>'canonical_key', 'reason', 'not a usable key') AS x
             FROM stg.rows i JOIN stg.lead_of lo ON lo.old_prospect_id = i.data->>'prospect_id'
            WHERE i.source_table = 'marketing_prospect_identities' AND lo.prospect_id = p.id
              AND (i.data->>'status' IN ('CONFLICTED', 'RETIRED')
                   OR (i.data->>'authority' = 'youtube' AND i.data->>'canonical_key' NOT LIKE 'UC%'))
           UNION ALL
           SELECT jsonb_build_object('kind', 'collision', 'authority', d.authority, 'key', d.key,
                                     'rule', d.rule, 'reason', 'key already claimed') AS x
             FROM stg.demoted d JOIN stg.lead l ON l.old_prospect_id = d.old_prospect_id
             JOIN stg.lead_of lo ON lo.old_prospect_id = l.old_prospect_id
            WHERE lo.prospect_id = p.id
         ) s), updated_at = now()
 WHERE EXISTS (SELECT 1 FROM stg.lead_of lo WHERE lo.prospect_id = p.id);

INSERT INTO prospect_aliases (id, prospect_id, alias, alias_key)
SELECT gen_random_uuid(), lo.prospect_id, btrim(r.data->>'display_name'), l.name_key
  FROM stg.rows r JOIN stg.lead l ON l.old_prospect_id = r.data->>'id'
  JOIN stg.lead_of lo ON lo.old_prospect_id = l.old_prospect_id
 WHERE r.source_table = 'marketing_prospects' AND btrim(r.data->>'display_name') <> l.business_name
   AND NOT EXISTS (SELECT 1 FROM prospect_aliases a WHERE a.alias_key = l.name_key);
COMMIT;
