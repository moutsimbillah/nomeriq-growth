-- Pass A: suppressions, leads, emails, sources, aliases and sender pins.
--
-- Reads only stg.rows (the staged export) and writes only the portal's own tables. Never touches live.
-- Counts, table names and codes go to the log; no record value is ever printed.
BEGIN;

-- ---------------------------------------------------------------- A1. the 57 permanent failures
INSERT INTO suppressions (id, normalized_email, email, reason, source, note, active)
SELECT gen_random_uuid(), lower(n.data->>'recipient'), lower(n.data->>'recipient'), 'bounce',
       'legacy_import', 'permanent failure recorded by the old portal', true
  FROM stg.rows n
 WHERE n.source_table = 'marketing_email_delivery_notices'
   AND coalesce(n.data->>'recipient', '') <> ''
   AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.normalized_email = lower(n.data->>'recipient'));

-- ---------------------------------------------------------------- A2. one row per old lead, resolved
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
       EXISTS (SELECT 1 FROM stg.rows t
                WHERE t.source_table = 'marketing_pipeline_transitions'
                  AND t.data->>'prospect_id' = r.data->>'id'
                  AND t.data->>'to_stage' IN ('OUTREACH', 'ENGAGED', 'CLOSED')) AS contacted,
       (SELECT t.data->>'occurred_at' FROM stg.rows t
         WHERE t.source_table = 'marketing_pipeline_transitions'
           AND t.data->>'prospect_id' = r.data->>'id' AND t.data->>'to_stage' = 'OUTREACH'
         ORDER BY t.data->>'occurred_at' LIMIT 1) AS contacted_at,
       (SELECT sc.data->>'research_client' FROM stg.rows sc
         WHERE sc.source_table = 'marketing_prospect_signal_categories'
           AND sc.data->>'prospect_id' = r.data->>'id' ORDER BY sc.ordinal DESC LIMIT 1) AS research_client,
       (SELECT CASE
                 WHEN jsonb_typeof(sc.data->'categories') = 'array'
                   THEN (SELECT jsonb_agg(e ORDER BY e) FROM jsonb_array_elements_text(sc.data->'categories') e
                          WHERE upper(e) NOT IN ('STOCKS', 'OPTIONS'))
                 WHEN jsonb_typeof(sc.data->'categories') = 'object'
                   THEN (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(sc.data->'categories') k
                          WHERE upper(k) NOT IN ('STOCKS', 'OPTIONS'))
                 ELSE '[]'::jsonb END
          FROM stg.rows sc
         WHERE sc.source_table = 'marketing_prospect_signal_categories'
           AND sc.data->>'prospect_id' = r.data->>'id' ORDER BY sc.ordinal DESC LIMIT 1) AS categories,
       (SELECT au.data->>'parsed_count' FROM stg.rows au
         WHERE au.source_table = 'marketing_prospect_audience_snapshots'
           AND au.data->>'prospect_id' = r.data->>'id' AND au.data->>'count_kind' = 'FOLLOWERS'
         ORDER BY au.data->>'observed_at' DESC LIMIT 1) AS followers,
       (SELECT au.data->>'parsed_count' FROM stg.rows au
         WHERE au.source_table = 'marketing_prospect_audience_snapshots'
           AND au.data->>'prospect_id' = r.data->>'id' AND au.data->>'count_kind' = 'SUBSCRIBERS'
         ORDER BY au.data->>'observed_at' DESC LIMIT 1) AS subscribers,
       (SELECT i.data->>'canonical_key' FROM stg.rows i
         WHERE i.source_table = 'marketing_prospect_identities' AND i.data->>'prospect_id' = r.data->>'id'
           AND i.data->>'authority' = 'domain' AND i.data->>'status' IN ('VERIFIED', 'PROPOSED')
         ORDER BY i.ordinal LIMIT 1) AS domain_key,
       (SELECT i.data->>'canonical_key' FROM stg.rows i
         WHERE i.source_table = 'marketing_prospect_identities' AND i.data->>'prospect_id' = r.data->>'id'
           AND i.data->>'authority' = 'instagram' AND i.data->>'status' IN ('VERIFIED', 'PROPOSED')
         ORDER BY i.ordinal LIMIT 1) AS instagram_key,
       (SELECT i.data->>'canonical_key' FROM stg.rows i
         WHERE i.source_table = 'marketing_prospect_identities' AND i.data->>'prospect_id' = r.data->>'id'
           AND i.data->>'authority' = 'youtube' AND i.data->>'status' IN ('VERIFIED', 'PROPOSED')
           AND i.data->>'canonical_key' LIKE 'UC%'
         ORDER BY i.ordinal LIMIT 1) AS youtube_key,
       (SELECT i.data->>'canonical_key' FROM stg.rows i
         WHERE i.source_table = 'marketing_prospect_identities' AND i.data->>'prospect_id' = r.data->>'id'
           AND i.data->>'authority' = 'x' AND i.data->>'status' IN ('VERIFIED', 'PROPOSED')
         ORDER BY i.ordinal LIMIT 1) AS x_key,
       (SELECT i.data->>'canonical_key' FROM stg.rows i
         WHERE i.source_table = 'marketing_prospect_identities' AND i.data->>'prospect_id' = r.data->>'id'
           AND i.data->>'authority' = 'telegram' AND i.data->>'status' IN ('VERIFIED', 'PROPOSED')
         ORDER BY i.ordinal LIMIT 1) AS telegram_key
  FROM stg.rows r
 WHERE r.source_table = 'marketing_prospects';

-- One claim per key: the earliest old row keeps it, any later claim is demoted to other_socials.
CREATE TABLE stg.demoted (old_prospect_id text, authority text, key text);
DO $do$
DECLARE col text;
BEGIN
  FOREACH col IN ARRAY ARRAY['domain_key', 'instagram_key', 'youtube_key', 'x_key', 'telegram_key'] LOOP
    EXECUTE format('INSERT INTO stg.demoted (old_prospect_id, authority, key) '
                   'SELECT old_prospect_id, %L, %I FROM stg.lead l WHERE %I IS NOT NULL '
                   'AND EXISTS (SELECT 1 FROM stg.lead o WHERE o.%I = l.%I AND o.ordinal < l.ordinal)',
                   col, col, col, col, col);
    EXECUTE format('UPDATE stg.lead l SET %I = NULL WHERE %I IS NOT NULL '
                   'AND EXISTS (SELECT 1 FROM stg.lead o WHERE o.%I = l.%I AND o.ordinal < l.ordinal)',
                   col, col, col, col);
  END LOOP;
END $do$;

-- A key already claimed by a lead that is already here is not claimed twice either.
DO $do2$
DECLARE col text;
BEGIN
  FOREACH col IN ARRAY ARRAY['domain_key', 'instagram_key', 'youtube_key', 'x_key', 'telegram_key'] LOOP
    EXECUTE format('INSERT INTO stg.demoted (old_prospect_id, authority, key) '
                   'SELECT old_prospect_id, %L, %I FROM stg.lead WHERE %I IS NOT NULL '
                   'AND EXISTS (SELECT 1 FROM prospects x WHERE x.%I = stg.lead.%I)',
                   col, col, col, col, col);
    EXECUTE format('UPDATE stg.lead SET %I = NULL WHERE %I IS NOT NULL '
                   'AND EXISTS (SELECT 1 FROM prospects x WHERE x.%I = stg.lead.%I)',
                   col, col, col, col);
  END LOOP;
END $do2$;

ALTER TABLE stg.lead ADD COLUMN status text;
UPDATE stg.lead SET status = CASE WHEN disposition = 'LOST' THEN 'lost'
                                  WHEN contacted THEN 'contacted'
                                  ELSE 'new' END;

-- ---------------------------------------------------------------- A3. the sender pin: every contacted lead
ALTER TABLE stg.lead ADD COLUMN profile_id uuid;
ALTER TABLE stg.lead ADD COLUMN pinned_at timestamptz;
UPDATE stg.lead SET profile_id = (SELECT id FROM email_accounts WHERE normalized_email = 'moutsim@nomeriq.com'),
                    pinned_at = CASE WHEN contacted THEN coalesce(contacted_at::timestamptz, now()) END
 WHERE contacted;

-- ---------------------------------------------------------------- A4. fold the leads that already exist,
-- identity first (domain, then each social key), then the name ignoring punctuation. A name-only fold
-- missed "Learn 2 Trade" against the existing Learn2Trade and "Tawsiyat (موقع توصيات)" against Tawsiyat,
-- and both then collided on their domain key.
UPDATE prospects p SET
       status = l.status,
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
    -- names differ by punctuation, spacing or a translated suffix: "Learn 2 Trade" is "Learn2Trade"
    OR regexp_replace(lower(l.business_name), '[^a-z0-9]', '', 'g')
       = regexp_replace(lower(btrim(p.business_name)), '[^a-z0-9]', '', 'g');

-- ---------------------------------------------------------------- A5. the leads that are new
INSERT INTO prospects (id, business_name, name_key, country, categories, follower_count, subscriber_count,
                       qualification_status, status, created_by_type, source_channel, source_agent,
                       sending_profile_id, sending_profile_pinned_at, last_contacted_at,
                       website_url, domain_key, instagram_key, youtube_key, x_key, telegram_key,
                       other_socials, metadata, do_not_contact, created_at, updated_at)
SELECT gen_random_uuid(), l.business_name, l.name_key, 'Unknown',
       coalesce(l.categories, '[]'::jsonb), l.followers, l.subscribers,
       'candidate', l.status, 'legacy', 'legacy_import',
       CASE upper(coalesce(l.research_client, '')) WHEN 'CLAUDE' THEN 'claude' WHEN 'CHATGPT' THEN 'chatgpt'
                                                   ELSE 'unknown' END,
       l.profile_id, l.pinned_at, l.contacted_at::timestamptz,
       CASE WHEN l.domain_key IS NOT NULL THEN 'https://' || l.domain_key END, l.domain_key,
       l.instagram_key, l.youtube_key, l.x_key, l.telegram_key,
       '[]'::jsonb,
       jsonb_build_object('legacy', jsonb_build_object('prospect_id', l.old_prospect_id,
            'pipeline', l.pipeline, 'disposition', l.disposition)),
       l.disposition = 'LOST', now(), now()
  FROM stg.lead l
 WHERE NOT EXISTS (SELECT 1 FROM prospects p WHERE lower(btrim(p.business_name)) = lower(l.business_name));

-- ---------------------------------------------------------------- A6. email addresses, sources, other socials
INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url, source_type, is_primary)
SELECT gen_random_uuid(), d.prospect_id, d.email, d.normalized_email, d.source_url, d.source_type,
       row_number() OVER (PARTITION BY d.prospect_id ORDER BY d.ordinal) = 1
  FROM (
        -- one row per address: an address is a key, and the earliest contact keeps it
        SELECT DISTINCT ON (lower(coalesce(c.data->>'normalized_locator', c.data->>'locator')))
               p.id AS prospect_id, c.data->>'locator' AS email,
               lower(coalesce(c.data->>'normalized_locator', c.data->>'locator')) AS normalized_email,
               c.data->>'source_reference' AS source_url,
               CASE WHEN c.data->>'official_status' = 'OFFICIAL' THEN 'official_website' ELSE 'public_profile' END
                 AS source_type,
               c.ordinal
          FROM stg.rows c
          JOIN stg.lead l ON l.old_prospect_id = c.data->>'prospect_id'
          JOIN prospects p ON lower(btrim(p.business_name)) = lower(l.business_name)
         WHERE c.source_table = 'marketing_prospect_contacts' AND c.data->>'route' = 'EMAIL'
           AND coalesce(c.data->>'locator', '') LIKE '%@%'
         ORDER BY lower(coalesce(c.data->>'normalized_locator', c.data->>'locator')), c.ordinal
       ) d
 WHERE NOT EXISTS (SELECT 1 FROM prospect_emails e WHERE e.normalized_email = d.normalized_email);

INSERT INTO prospect_sources (id, prospect_id, url, label, source_type, observed_at, notes)
SELECT gen_random_uuid(), p.id,
       CASE WHEN i.data->>'authority' = 'domain' THEN 'https://' || (i.data->>'canonical_key')
            WHEN i.data->>'authority' = 'youtube' THEN 'https://youtube.com/channel/' || (i.data->>'canonical_key')
            WHEN i.data->>'authority' = 'instagram' THEN 'https://instagram.com/' || (i.data->>'canonical_key')
            WHEN i.data->>'authority' = 'telegram' THEN 'https://t.me/' || (i.data->>'canonical_key')
            WHEN i.data->>'authority' = 'x' THEN 'https://x.com/' || (i.data->>'canonical_key')
            ELSE i.data->>'canonical_key' END,
       initcap(i.data->>'authority'), 'official_website', (i.data->>'created_at')::timestamptz,
       'old portal identity, ' || (i.data->>'status')
  FROM stg.rows i
  JOIN stg.lead l ON l.old_prospect_id = i.data->>'prospect_id'
  JOIN prospects p ON lower(btrim(p.business_name)) = lower(l.business_name)
 WHERE i.source_table = 'marketing_prospect_identities'
   AND i.data->>'status' IN ('VERIFIED', 'PROPOSED')
   AND i.data->>'authority' <> 'domain'
   AND NOT EXISTS (SELECT 1 FROM prospect_sources s WHERE s.prospect_id = p.id
                     AND s.url = CASE WHEN i.data->>'authority' = 'youtube' THEN 'https://youtube.com/channel/' || (i.data->>'canonical_key')
                                       WHEN i.data->>'authority' = 'instagram' THEN 'https://instagram.com/' || (i.data->>'canonical_key')
                                       WHEN i.data->>'authority' = 'telegram' THEN 'https://t.me/' || (i.data->>'canonical_key')
                                       WHEN i.data->>'authority' = 'x' THEN 'https://x.com/' || (i.data->>'canonical_key')
                                       ELSE i.data->>'canonical_key' END);

-- non-email routes, malformed handles and demoted identities: kept, but not as keys
UPDATE prospects p SET other_socials = (
         SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM (
           SELECT jsonb_build_object('kind', 'route', 'route', c.data->>'route',
                                     'locator', c.data->>'locator', 'official', c.data->>'official_status') AS x
             FROM stg.rows c, stg.lead l
            WHERE c.source_table = 'marketing_prospect_contacts' AND c.data->>'route' <> 'EMAIL'
              AND c.data->>'prospect_id' = l.old_prospect_id AND l.business_name = btrim(p.business_name)
           UNION ALL
           SELECT jsonb_build_object('kind', 'identity', 'authority', i.data->>'authority',
                                     'key', i.data->>'canonical_key', 'reason', 'not a usable key') AS x
             FROM stg.rows i, stg.lead l
            WHERE i.source_table = 'marketing_prospect_identities'
              AND i.data->>'prospect_id' = l.old_prospect_id AND l.business_name = btrim(p.business_name)
              AND (i.data->>'status' IN ('CONFLICTED', 'RETIRED')
                   OR (i.data->>'authority' = 'youtube' AND i.data->>'canonical_key' NOT LIKE 'UC%'))
           UNION ALL
           SELECT jsonb_build_object('kind', 'collision', 'authority', d.authority, 'key', d.key,
                                     'reason', 'key already claimed by another lead') AS x
             FROM stg.demoted d, stg.lead l
            WHERE d.old_prospect_id = l.old_prospect_id AND l.business_name = btrim(p.business_name)
         ) s), updated_at = now()
 WHERE p.created_by_type = 'legacy' AND EXISTS (
         SELECT 1 FROM stg.lead l WHERE l.business_name = btrim(p.business_name));

-- ---------------------------------------------------------------- A7. aliases, where the raw name differs
INSERT INTO prospect_aliases (id, prospect_id, alias, alias_key)
SELECT gen_random_uuid(), p.id, btrim(r.data->>'display_name'), l.name_key
  FROM stg.rows r JOIN stg.lead l ON l.old_prospect_id = r.data->>'id'
  JOIN prospects p ON lower(btrim(p.business_name)) = lower(l.business_name)
 WHERE r.source_table = 'marketing_prospects'
   AND btrim(r.data->>'display_name') <> p.business_name
   AND NOT EXISTS (SELECT 1 FROM prospect_aliases a WHERE a.alias_key = l.name_key);
COMMIT;
