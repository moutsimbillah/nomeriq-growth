-- The import's own mailbox is never the default sender.
--
-- moutsim@nomeriq.com exists so the messages the import brought in have a mailbox to belong to, and the
-- approved decision is that it may only be used by the leads the import pinned to it. The resolver used
-- to pick the one row it could find and call it the default, so every lead the import did not pin was
-- shown — and could be sent from — nomeriq.com. This marks the address so that cannot happen again: a
-- mailbox marked never_default is not the default even if some later write sets is_default on it, and
-- the API refuses to make it one.
--
-- Additive and safe to re-run: one column with a default (no existing row changes value), and one
-- UPDATE that only ever touches the import's own address.

ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS never_default boolean NOT NULL DEFAULT false;

UPDATE email_accounts
   SET never_default = true,
       is_default = false,
       updated_at = now()
 WHERE normalized_email = 'moutsim@nomeriq.com'
   AND (never_default = false OR is_default = true);
