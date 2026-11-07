-- Founder-approved lead model. Rules: docs/lead-rules.md.
-- Additive, safe to repeat; no backfill or change to any existing lead/decision.
CREATE TABLE IF NOT EXISTS prospect_assessments (
  id uuid PRIMARY KEY,
  prospect_id uuid NOT NULL REFERENCES prospects(id),
  rules_version text NOT NULL,
  assessed_at timestamptz NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('research', 'legacy_backfill', 'founder')),
  source_reference text,
  source_agent text,
  ai_provider text,
  ai_model text,
  eligibility text NOT NULL DEFAULT 'unknown' CHECK (eligibility IN ('unknown', 'eligible', 'excluded')),
  eligibility_checks jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(eligibility_checks) = 'object'),
  exclusion_reason text,
  tier text CHECK (tier IN ('tier_1', 'other', 'email_no_website', 'category_b', 'excluded')),
  platform_maturity text NOT NULL DEFAULT 'unknown' CHECK (platform_maturity IN ('unknown', 'fragmented', 'partial', 'integrated')),
  mobile_app_status text NOT NULL DEFAULT 'unknown' CHECK (mobile_app_status IN ('unknown', 'verified_present', 'not_found_in_checked_sources', 'verified_absent')),
  product_fit text NOT NULL DEFAULT 'unknown' CHECK (product_fit IN ('unknown', 'high', 'medium', 'low')),
  capability_gaps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capability_gaps) = 'array'),
  findings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  sources_checked jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources_checked) = 'array'),
  missing_information jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(missing_information) = 'array'),
  fit_reasoning text NOT NULL DEFAULT '',
  research_confidence text NOT NULL DEFAULT 'unknown' CHECK (research_confidence IN ('unknown', 'low', 'medium', 'high')),
  priority_score integer CHECK (priority_score BETWEEN 0 AND 100),
  priority_components jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(priority_components) = 'object'),
  priority_provisional boolean NOT NULL DEFAULT true,
  legacy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(legacy_snapshot) = 'object'),
  provenance_key text NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (eligibility <> 'excluded' OR (tier IS NOT DISTINCT FROM 'excluded' AND length(btrim(coalesce(exclusion_reason, ''))) > 0)),
  CHECK (tier IS DISTINCT FROM 'excluded' OR eligibility = 'excluded'),
  CHECK (tier IS NULL OR tier = 'excluded' OR eligibility = 'eligible')
);
CREATE INDEX IF NOT EXISTS prospect_assessments_latest_idx ON prospect_assessments (prospect_id, assessed_at DESC, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS prospect_assessments_filter_idx ON prospect_assessments (tier, product_fit, priority_score DESC);
CREATE TABLE IF NOT EXISTS prospect_audience_observations (
  id uuid PRIMARY KEY,
  prospect_id uuid NOT NULL REFERENCES prospects(id),
  platform text NOT NULL CHECK (platform IN ('instagram', 'youtube', 'telegram')),
  account_key text NOT NULL,
  handle text,
  account_url text NOT NULL,
  count_value bigint CHECK (count_value >= 0),
  count_state text NOT NULL CHECK (count_state IN ('verified', 'unknown')),
  displayed_text text,
  is_approximate boolean NOT NULL DEFAULT false,
  checked_at timestamptz NOT NULL,
  source_url text NOT NULL,
  official_link_source_url text,
  engagement_signal jsonb CHECK (engagement_signal IS NULL OR jsonb_typeof(engagement_signal) = 'object'),
  provenance_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((count_state = 'verified' AND count_value IS NOT NULL) OR (count_state = 'unknown' AND count_value IS NULL)),
  CHECK (length(btrim(account_key)) > 0)
);
CREATE INDEX IF NOT EXISTS prospect_audience_observations_latest_idx ON prospect_audience_observations (prospect_id, platform, account_key, checked_at DESC, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS prospect_contact_route_observations (
  id uuid PRIMARY KEY,
  prospect_id uuid NOT NULL REFERENCES prospects(id),
  platform text NOT NULL,
  route_kind text NOT NULL CHECK (route_kind IN ('dm', 'group', 'channel', 'bot', 'form', 'other')),
  handle text,
  route_url text,
  official_status text NOT NULL DEFAULT 'unknown' CHECK (official_status IN ('verified', 'unknown', 'unofficial')),
  checked_at timestamptz NOT NULL,
  source_url text NOT NULL,
  official_link_source_url text,
  notes text NOT NULL DEFAULT '',
  provenance_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(btrim(coalesce(handle, ''))) > 0 OR length(btrim(coalesce(route_url, ''))) > 0)
);
CREATE INDEX IF NOT EXISTS prospect_contact_routes_latest_idx ON prospect_contact_route_observations (prospect_id, platform, route_kind, checked_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS prospect_assessment_overrides (
  id uuid PRIMARY KEY,
  prospect_id uuid NOT NULL REFERENCES prospects(id),
  field_name text NOT NULL CHECK (field_name IN ('eligibility', 'tier', 'platform_maturity', 'mobile_app_status', 'capability_gaps', 'product_fit', 'research_confidence', 'priority_score')),
  decision text NOT NULL CHECK (decision IN ('set', 'clear')),
  value jsonb,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  decided_by uuid NOT NULL REFERENCES users(id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  provenance_key text NOT NULL UNIQUE,
  CHECK ((decision = 'set' AND value IS NOT NULL) OR (decision = 'clear' AND value IS NULL))
);
CREATE INDEX IF NOT EXISTS prospect_assessment_overrides_latest_idx ON prospect_assessment_overrides (prospect_id, field_name, decided_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS prospect_rejection_recommendations (
  id uuid PRIMARY KEY,
  prospect_id uuid NOT NULL REFERENCES prospects(id),
  message_id uuid NOT NULL REFERENCES messages(id),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  objection text NOT NULL CHECK (length(btrim(objection)) > 0),
  suggested_outcome text NOT NULL DEFAULT 'lost' CHECK (suggested_outcome = 'lost'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  provenance_key text NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS prospect_rejection_recommendations_lead_idx ON prospect_rejection_recommendations (prospect_id, recorded_at DESC, id DESC);
ALTER TABLE prospect_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_audience_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_contact_route_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_assessment_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_rejection_recommendations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON prospect_assessments FROM PUBLIC;
REVOKE ALL ON prospect_audience_observations FROM PUBLIC;
REVOKE ALL ON prospect_contact_route_observations FROM PUBLIC;
REVOKE ALL ON prospect_assessment_overrides FROM PUBLIC;
REVOKE ALL ON prospect_rejection_recommendations FROM PUBLIC;
