-- A founder may type a recipient the research never found — a corrected address, an address a reply
-- came from. It is saved as a founder-entered contact so the send gate stops refusing it, and so the
-- difference between a source-confirmed address and a founder's word is still visible on the lead.
--
-- Additive and safe to re-run: the check is replaced with a wider set, nothing is dropped, and no
-- existing row changes. AI-written drafts still take the recipient from the prospect's confirmed
-- address and never accept one of their own.

ALTER TABLE prospect_emails DROP CONSTRAINT IF EXISTS prospect_emails_source_type_check;
ALTER TABLE prospect_emails ADD CONSTRAINT prospect_emails_source_type_check
  CHECK (source_type IN
    ('official_website', 'official_social', 'official_directory', 'public_profile', 'founder_entered'));
