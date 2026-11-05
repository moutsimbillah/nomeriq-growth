-- Some leads must never receive an automatic follow-up, without being suppressed from contact by hand.
--
-- A brand-risk or disqualified assessment is a reason not to write again on its own; marking the lead
-- do_not_contact would also stop the founder writing deliberately, which is not what is meant. Additive.

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS follow_up_excluded boolean NOT NULL DEFAULT false;
