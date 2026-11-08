-- Additive, replay-safe. Existing leads/history are not rewritten or auto-merged.
CREATE OR REPLACE FUNCTION growth_identity_domain(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN host ~ '^[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+$'
    AND host !~ '(^|\.)(instagram\.com|youtube\.com|youtu\.be|t\.me|telegram\.me|telegram\.org|x\.com|twitter\.com|facebook\.com|fb\.com|linkedin\.com|linktr\.ee|beacons\.ai|taplink\.cc|bio\.site|discord\.com|discord\.gg|whatsapp\.com|wa\.me)$'
    THEN host ELSE NULL END
  FROM (SELECT regexp_replace(split_part(split_part(regexp_replace(lower(trim(value)), '^https?://', ''), '/', 1), ':', 1), '^www\.|\.$', '', 'g') AS host) h
$$;

-- Free-mail hosts are never business identity domains: two different inboxes at one provider are
-- two different businesses. Exact hosts only (no wildcard country-domain guesses). This is the one
-- list: every reader calls these SQL functions instead of keeping a copy.
CREATE OR REPLACE FUNCTION growth_business_email_domain(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN trim(value) ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
    AND host !~ '(^|\.)(gmail\.com|googlemail\.com|outlook\.com|outlook\.fr|hotmail\.com|hotmail\.co\.uk|live\.com|live\.co\.uk|msn\.com|yahoo\.com|yahoo\.co\.uk|yahoo\.fr|yahoo\.co\.in|ymail\.com|rocketmail\.com|icloud\.com|me\.com|mac\.com|aol\.com|proton\.me|protonmail\.com|pm\.me|mail\.com|mail\.ru|gmx\.com|gmx\.de|gmx\.net|gmx\.at|web\.de|yandex\.com|yandex\.ru|qq\.com|163\.com|126\.com|zoho\.com|fastmail\.com|tutanota\.com|tuta\.com|rediffmail\.com)$'
    THEN host ELSE NULL END
  FROM (SELECT growth_identity_domain(split_part(lower(trim(value)), '@', 2)) AS host) h
$$;

CREATE OR REPLACE FUNCTION growth_specific_email(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN split_part(lower(trim(value)), '@', 1) <> ALL(ARRAY[
    'info','support','contact','sales','hello','admin','team','office','help','service','services',
    'enquiries','enquiry','marketing','billing','press','careers','jobs','general','mail','inquiries'])
    THEN lower(trim(value)) ELSE NULL END
$$;

CREATE INDEX IF NOT EXISTS prospects_canonical_domain_idx ON prospects (growth_identity_domain(domain_key));
CREATE INDEX IF NOT EXISTS prospect_emails_business_domain_idx ON prospect_emails (growth_business_email_domain(normalized_email));
CREATE INDEX IF NOT EXISTS prospect_emails_normalized_lookup_idx ON prospect_emails (normalized_email);
CREATE INDEX IF NOT EXISTS prospects_name_lookup_idx ON prospects (name_key);
CREATE INDEX IF NOT EXISTS prospect_audience_identity_lookup_idx ON prospect_audience_observations (platform, account_key);

-- The founder's reversible "Duplicate of" link. Created before the SQL helpers below, because a
-- SQL-language function's table references are resolved when the function is created.
CREATE TABLE IF NOT EXISTS prospect_duplicate_links (
  id uuid PRIMARY KEY,
  prospect_id uuid NOT NULL REFERENCES prospects(id),
  canonical_prospect_id uuid NOT NULL REFERENCES prospects(id),
  previous_state jsonb NOT NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  restored_at timestamptz,
  CHECK (prospect_id <> canonical_prospect_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS prospect_duplicate_links_active_unique ON prospect_duplicate_links (prospect_id) WHERE restored_at IS NULL;
CREATE INDEX IF NOT EXISTS prospect_duplicate_links_canonical_idx ON prospect_duplicate_links (canonical_prospect_id) WHERE restored_at IS NULL;
ALTER TABLE prospect_duplicate_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON prospect_duplicate_links FROM PUBLIC;

-- The active canonical owner of a lead's identity family: the lead the founder kept when marking
-- this one a duplicate, or the lead itself when it is not currently marked. One level only: the
-- mark service refuses chains, so an active link always points at the family's real canonical.
CREATE OR REPLACE FUNCTION growth_identity_owner(prospect uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(
    (SELECT l.canonical_prospect_id FROM prospect_duplicate_links l
      WHERE l.prospect_id = prospect AND l.restored_at IS NULL LIMIT 1),
    prospect)
$$;


-- One resolver for lookup, save-time checks and direct-write guards, including archived leads.
-- Domain overlap is a reason to hold for review, NEVER proof of ownership or permission to merge.
-- Every match is reported as its canonical family owner, so a hit on a lead the founder already
-- linked as a duplicate points at the lead they kept (nothing is moved or merged).
-- ignore_target is an internal parameter for a write to an EXISTING lead (the lead being written),
-- never an MCP/user payload field. It exempts only that lead's own linked family, so the canonical
-- lead's distinct new addresses and identity edits do not collide with duplicates the founder has
-- already resolved. New saves pass nothing and keep full protection against every family.
CREATE OR REPLACE FUNCTION growth_find_identity_matches(
  domains text[], emails text[], names text[], instagram text[], youtube text[], x_handles text[], telegram text[], profiles text[],
  ignore_target uuid
) RETURNS TABLE(prospect_id uuid, reasons text[])
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  WITH incoming_domains AS (
    SELECT DISTINCT growth_identity_domain(v) AS key FROM unnest(domains) v
    WHERE growth_identity_domain(v) IS NOT NULL
  ), incoming_email_domains AS (
    SELECT DISTINCT growth_business_email_domain(v) AS key FROM unnest(emails) v
    WHERE growth_business_email_domain(v) IS NOT NULL
  ), hits AS (
    SELECT p.id, 'official website domain' AS reason FROM prospects p
      WHERE growth_identity_domain(p.domain_key) IN (SELECT key FROM incoming_domains)
    UNION ALL
    SELECT p.id, 'business email domain' FROM prospects p
      WHERE growth_identity_domain(p.domain_key) IN (SELECT key FROM incoming_email_domains)
    UNION ALL
    SELECT e.prospect_id, 'business email domain' FROM prospect_emails e
      WHERE growth_business_email_domain(e.normalized_email) IN
        (SELECT key FROM incoming_domains UNION SELECT key FROM incoming_email_domains)
    UNION ALL
    SELECT e.prospect_id, 'contact email' FROM prospect_emails e
      WHERE e.normalized_email IN (SELECT growth_specific_email(v) FROM unnest(emails) v)
    UNION ALL
    SELECT p.id, 'business name or alias' FROM prospects p WHERE p.name_key = ANY(names)
    UNION ALL
    SELECT a.prospect_id, 'business name or alias' FROM prospect_aliases a WHERE a.alias_key = ANY(names)
    UNION ALL
    SELECT p.id, 'Instagram handle' FROM prospects p WHERE p.instagram_key = ANY(instagram)
    UNION ALL
    SELECT p.id, 'YouTube channel' FROM prospects p WHERE p.youtube_key = ANY(youtube)
    UNION ALL
    SELECT p.id, 'X handle' FROM prospects p WHERE p.x_key = ANY(x_handles)
    UNION ALL
    SELECT p.id, 'Telegram handle' FROM prospects p WHERE p.telegram_key = ANY(telegram)
    UNION ALL
    SELECT a.prospect_id, 'social identity' FROM prospect_audience_observations a WHERE
      (a.platform='instagram' AND a.account_key=ANY(instagram)) OR
      (a.platform='youtube' AND a.account_key=ANY(youtube)) OR
      (a.platform='telegram' AND a.account_key=ANY(telegram))
    UNION ALL
    SELECT p.id, 'official shared-host profile' FROM prospects p WHERE
      lower(regexp_replace(regexp_replace(split_part(p.website_url,'?',1),'^https?://(www\.)?','','i'),'/$',''))=ANY(profiles)
  ), owned AS (
    SELECT growth_identity_owner(h.id) AS owner_id, h.reason FROM hits h
  )
  SELECT o.owner_id, array_agg(DISTINCT o.reason ORDER BY o.reason) FROM owned o
  WHERE ignore_target IS NULL OR o.owner_id <> growth_identity_owner(ignore_target)
  GROUP BY o.owner_id
$$;

-- Preserve the original lookup signature without destructive DDL. Only internal existing-lead
-- writers call the required 9th parameter; all 8-argument readers retain full family protection.
CREATE OR REPLACE FUNCTION growth_find_identity_matches(
  domains text[], emails text[], names text[], instagram text[], youtube text[], x_handles text[], telegram text[], profiles text[]
) RETURNS TABLE(prospect_id uuid, reasons text[])
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT * FROM growth_find_identity_matches(domains, emails, names, instagram, youtube, x_handles, telegram, profiles, NULL::uuid)
$$;

CREATE OR REPLACE FUNCTION growth_guard_prospect_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conflict_id uuid;
BEGIN
  IF TG_OP='UPDATE' AND
    ROW(NEW.name_key,NEW.domain_key,NEW.website_url,NEW.instagram_key,NEW.youtube_key,NEW.x_key,NEW.telegram_key)
    IS NOT DISTINCT FROM ROW(OLD.name_key,OLD.domain_key,OLD.website_url,OLD.instagram_key,OLD.youtube_key,OLD.x_key,OLD.telegram_key)
    THEN RETURN NEW; END IF;
  LOCK TABLE prospects IN SHARE ROW EXCLUSIVE MODE;
  -- A brand-new row has no duplicate link yet, so passing its id exempts only itself.
  SELECT m.prospect_id INTO conflict_id FROM growth_find_identity_matches(
    ARRAY[NEW.domain_key, growth_identity_domain(NEW.website_url)], ARRAY[]::text[], ARRAY[NEW.name_key],
    ARRAY[NEW.instagram_key],ARRAY[NEW.youtube_key],ARRAY[NEW.x_key],ARRAY[NEW.telegram_key],
    CASE WHEN growth_identity_domain(NEW.website_url) IS NULL THEN ARRAY[lower(regexp_replace(regexp_replace(split_part(NEW.website_url,'?',1),'^https?://(www\.)?','','i'),'/$',''))] ELSE ARRAY[]::text[] END,
    NEW.id
  ) m WHERE m.prospect_id<>NEW.id LIMIT 1;
  IF conflict_id IS NOT NULL THEN
    RAISE EXCEPTION 'A recorded business identity already exists; review the existing lead.' USING ERRCODE='23505', CONSTRAINT='growth_identity_conflict';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION growth_guard_prospect_email() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conflict_id uuid;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.prospect_id,NEW.normalized_email) IS NOT DISTINCT FROM ROW(OLD.prospect_id,OLD.normalized_email) THEN RETURN NEW; END IF;
  LOCK TABLE prospects IN SHARE ROW EXCLUSIVE MODE;
  SELECT m.prospect_id INTO conflict_id FROM growth_find_identity_matches(
    ARRAY[]::text[],ARRAY[NEW.normalized_email],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],
    NEW.prospect_id
  ) m WHERE m.prospect_id<>NEW.prospect_id LIMIT 1;
  IF conflict_id IS NOT NULL THEN
    RAISE EXCEPTION 'A recorded contact identity already exists; review the existing lead.' USING ERRCODE='23505', CONSTRAINT='growth_identity_conflict';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION growth_guard_prospect_alias() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conflict_id uuid;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.prospect_id,NEW.alias_key) IS NOT DISTINCT FROM ROW(OLD.prospect_id,OLD.alias_key) THEN RETURN NEW; END IF;
  LOCK TABLE prospects IN SHARE ROW EXCLUSIVE MODE;
  SELECT m.prospect_id INTO conflict_id FROM growth_find_identity_matches(
    ARRAY[]::text[],ARRAY[]::text[],ARRAY[NEW.alias_key],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],
    NEW.prospect_id
  ) m WHERE m.prospect_id<>NEW.prospect_id LIMIT 1;
  IF conflict_id IS NOT NULL THEN
    RAISE EXCEPTION 'A recorded business alias already exists; review the existing lead.' USING ERRCODE='23505', CONSTRAINT='growth_identity_conflict';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION growth_guard_prospect_audience() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conflict_id uuid;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.prospect_id,NEW.platform,NEW.account_key) IS NOT DISTINCT FROM ROW(OLD.prospect_id,OLD.platform,OLD.account_key) THEN RETURN NEW; END IF;
  LOCK TABLE prospects IN SHARE ROW EXCLUSIVE MODE;
  SELECT m.prospect_id INTO conflict_id FROM growth_find_identity_matches(
    ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],
    CASE WHEN NEW.platform='instagram' THEN ARRAY[NEW.account_key] ELSE ARRAY[]::text[] END,
    CASE WHEN NEW.platform='youtube' THEN ARRAY[NEW.account_key] ELSE ARRAY[]::text[] END,
    ARRAY[]::text[],CASE WHEN NEW.platform='telegram' THEN ARRAY[NEW.account_key] ELSE ARRAY[]::text[] END,ARRAY[]::text[],
    NEW.prospect_id
  ) m WHERE m.prospect_id<>NEW.prospect_id LIMIT 1;
  IF conflict_id IS NOT NULL THEN
    RAISE EXCEPTION 'A recorded social identity already exists; review the existing lead.' USING ERRCODE='23505', CONSTRAINT='growth_identity_conflict';
  END IF;
  RETURN NEW;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='growth_prospect_identity_guard') THEN
    CREATE TRIGGER growth_prospect_identity_guard BEFORE INSERT OR UPDATE ON prospects FOR EACH ROW EXECUTE FUNCTION growth_guard_prospect_identity();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='growth_prospect_email_guard') THEN
    CREATE TRIGGER growth_prospect_email_guard BEFORE INSERT OR UPDATE ON prospect_emails FOR EACH ROW EXECUTE FUNCTION growth_guard_prospect_email();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='growth_prospect_alias_guard') THEN
    CREATE TRIGGER growth_prospect_alias_guard BEFORE INSERT OR UPDATE ON prospect_aliases FOR EACH ROW EXECUTE FUNCTION growth_guard_prospect_alias();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='growth_prospect_audience_guard') THEN
    CREATE TRIGGER growth_prospect_audience_guard BEFORE INSERT OR UPDATE ON prospect_audience_observations FOR EACH ROW EXECUTE FUNCTION growth_guard_prospect_audience();
  END IF;
END $$;
