-- An imported message needs its own source value.
--
-- `messages.source` says how a row got here: `smtp` or `imap` (the transport), `seed` (demo data),
-- `system` (generated in the portal). None of those is true of a message that arrived through the
-- import: it was not sent or fetched by this portal, and calling it `imap` would claim a mailbox
-- connection that did not exist at the time.
--
-- Additive and safe to re-run: the check is replaced with a wider set and no row is touched. Nothing is
-- written with the new value until the importer runs.

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_source_check;
ALTER TABLE messages ADD CONSTRAINT messages_source_check
  CHECK (source IN ('smtp', 'imap', 'seed', 'system', 'legacy_import'));