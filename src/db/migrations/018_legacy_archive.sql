-- The old portal's own record, kept as it was.
--
-- The import maps the essentials into this portal's tables: leads, contacts, evidence, categories,
-- messages, conversations, drafts, suppressions. Everything else has no home here — qualification
-- assessments and scores, eligibility reviews, stage transitions, sequences with their angle and wave,
-- approval snapshots and fingerprints, revocations, intents, outreach events, transport evidence, hold
-- history, conversation links and attention, reply suggestions, sales bindings, every superseded
-- proposal version — and it is exactly the history the learning phase will want: which angles got
-- replies, which stages stalled, why leads were lost.
--
-- So every exported table is kept, including the ones that are also mapped. The archive is the original:
-- a reconciliation can compare the two, and a mapping mistake is recoverable rather than final.
--
-- Shape: each row is stored whole, as `data jsonb`, with its old id as text. Typing every column of
-- thirty-odd foreign tables by hand would re-derive a schema this portal will never enforce, and would
-- drift from the export; jsonb keeps the row exactly as it arrived and is still queryable
-- (`data->>'field'`). The manifest already declares each table's columns and types, so the importer
-- validates as it loads.
--
-- The id. Thirty-seven tables carry their own, and it is used as it is. Ten have no id column, and for
-- those the id is derived from the tuple the exporter itself ordered by — measured unique across every
-- row of each file, with no nulls in any key column:
--
--   conversation_attention          target_key
--   conversation_links              account_id, message_id
--   email_preflight_blocks          dispatch_id
--   email_transport_evidence        dispatch_id
--   identity_corroborations         identity_id
--   reply_excerpts                  source_id
--   reply_suggestion_decisions      suggestion_id
--   sales_draft_bindings            draft_id
--   sales_proposal_bindings         proposal_id
--   workspace_revocations           approval_id
--
-- `archiveRowId()` in `src/lib/import/rowId.ts` hashes that tuple as a JSON array — not as joined text,
-- which would let ("a","bc") and ("ab","c") collide — into `sha256:<hex>`. Deterministic, so a second
-- import updates the same row instead of duplicating the archive; and it refuses a null key value
-- rather than putting unrelated rows in one bucket. Its test pins the collision cases.
--
-- READ-ONLY to the application. Nothing in `src/` reads this schema — a test enforces that — and the
-- importer is the only writer. Additive and safe to re-run.
--
-- AFTER the import, the importer revokes INSERT, UPDATE and DELETE on every legacy table from the
-- application's database role, so read-only is enforced by the database and not only by convention. The
-- dry run proves it: it attempts each write as the app role and reports the refusal.

CREATE SCHEMA IF NOT EXISTS legacy;

-- Provenance: one row per exported file, so the reconciliation report can prove what was loaded,
-- from which file, and with which checksum.
CREATE TABLE IF NOT EXISTS legacy.import_files (
  file text PRIMARY KEY,
  source_table text,
  sha256 text NOT NULL,
  rows integer NOT NULL,
  bytes integer NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON SCHEMA legacy IS
  'The old portal, unchanged. Read-only to the app, written only by the importer.';

-- marketing_contact_checks
CREATE TABLE IF NOT EXISTS legacy.marketing_contact_checks (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_conversation_attention
CREATE TABLE IF NOT EXISTS legacy.marketing_conversation_attention (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_conversation_links
CREATE TABLE IF NOT EXISTS legacy.marketing_conversation_links (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_delivery_accounts
CREATE TABLE IF NOT EXISTS legacy.marketing_delivery_accounts (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_eligibility_reviews
CREATE TABLE IF NOT EXISTS legacy.marketing_eligibility_reviews (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_email_delivery_notices
CREATE TABLE IF NOT EXISTS legacy.marketing_email_delivery_notices (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_email_dispatches
CREATE TABLE IF NOT EXISTS legacy.marketing_email_dispatches (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_email_holds
CREATE TABLE IF NOT EXISTS legacy.marketing_email_holds (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_email_inbound
CREATE TABLE IF NOT EXISTS legacy.marketing_email_inbound (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_email_inbound_payloads
CREATE TABLE IF NOT EXISTS legacy.marketing_email_inbound_payloads (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_email_preflight_blocks
CREATE TABLE IF NOT EXISTS legacy.marketing_email_preflight_blocks (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_email_recoveries
CREATE TABLE IF NOT EXISTS legacy.marketing_email_recoveries (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_email_transport_evidence
CREATE TABLE IF NOT EXISTS legacy.marketing_email_transport_evidence (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_growth_thread_messages
CREATE TABLE IF NOT EXISTS legacy.marketing_growth_thread_messages (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_growth_threads
CREATE TABLE IF NOT EXISTS legacy.marketing_growth_threads (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_identity_corroborations
CREATE TABLE IF NOT EXISTS legacy.marketing_identity_corroborations (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_mailbox_drafts
CREATE TABLE IF NOT EXISTS legacy.marketing_mailbox_drafts (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_mailbox_messages
CREATE TABLE IF NOT EXISTS legacy.marketing_mailbox_messages (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_mailbox_payloads
CREATE TABLE IF NOT EXISTS legacy.marketing_mailbox_payloads (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_message_proposals
CREATE TABLE IF NOT EXISTS legacy.marketing_message_proposals (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_opportunities
CREATE TABLE IF NOT EXISTS legacy.marketing_opportunities (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_outreach_draft_approvals
CREATE TABLE IF NOT EXISTS legacy.marketing_outreach_draft_approvals (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_outreach_drafts
CREATE TABLE IF NOT EXISTS legacy.marketing_outreach_drafts (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_outreach_events
CREATE TABLE IF NOT EXISTS legacy.marketing_outreach_events (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_outreach_intents
CREATE TABLE IF NOT EXISTS legacy.marketing_outreach_intents (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_outreach_replies
CREATE TABLE IF NOT EXISTS legacy.marketing_outreach_replies (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_outreach_sequences
CREATE TABLE IF NOT EXISTS legacy.marketing_outreach_sequences (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_pipeline_transitions
CREATE TABLE IF NOT EXISTS legacy.marketing_pipeline_transitions (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_policy_findings
CREATE TABLE IF NOT EXISTS legacy.marketing_policy_findings (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_prospect_audience_snapshots
CREATE TABLE IF NOT EXISTS legacy.marketing_prospect_audience_snapshots (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_prospect_constraints
CREATE TABLE IF NOT EXISTS legacy.marketing_prospect_constraints (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_prospect_contacts
CREATE TABLE IF NOT EXISTS legacy.marketing_prospect_contacts (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_prospect_evidence
CREATE TABLE IF NOT EXISTS legacy.marketing_prospect_evidence (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_prospect_identities
CREATE TABLE IF NOT EXISTS legacy.marketing_prospect_identities (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_prospect_inbound_links
CREATE TABLE IF NOT EXISTS legacy.marketing_prospect_inbound_links (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_prospect_signal_categories
CREATE TABLE IF NOT EXISTS legacy.marketing_prospect_signal_categories (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_prospects
CREATE TABLE IF NOT EXISTS legacy.marketing_prospects (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_qualification_assessments
CREATE TABLE IF NOT EXISTS legacy.marketing_qualification_assessments (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_reply_excerpts
CREATE TABLE IF NOT EXISTS legacy.marketing_reply_excerpts (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_reply_suggestion_decisions
CREATE TABLE IF NOT EXISTS legacy.marketing_reply_suggestion_decisions (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_reply_suggestions
CREATE TABLE IF NOT EXISTS legacy.marketing_reply_suggestions (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_sales_draft_bindings
CREATE TABLE IF NOT EXISTS legacy.marketing_sales_draft_bindings (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_sales_proposal_bindings
CREATE TABLE IF NOT EXISTS legacy.marketing_sales_proposal_bindings (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_sender_profiles
CREATE TABLE IF NOT EXISTS legacy.marketing_sender_profiles (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_workspace_payloads
CREATE TABLE IF NOT EXISTS legacy.marketing_workspace_payloads (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_workspace_revocations
CREATE TABLE IF NOT EXISTS legacy.marketing_workspace_revocations (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
-- marketing_workspace_sources
CREATE TABLE IF NOT EXISTS legacy.marketing_workspace_sources (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
