-- A send held back by the account's own minimum interval is not a failure: it is waiting, and a
-- scheduler must be able to find it. Until now the attempt row was deleted on a "too soon", which left
-- the draft approved but invisible to any clock — the founder had to press Send again by hand.
--
-- Additive and safe to re-run: the check is replaced with a wider set, one nullable column is added,
-- and no existing row is touched (every row today is accepted, sandbox, failed, uncertain, blocked or
-- sending — none of them is 'queued').

ALTER TABLE outbound_sends ADD COLUMN IF NOT EXISTS queued_at timestamptz;

ALTER TABLE outbound_sends DROP CONSTRAINT IF EXISTS outbound_sends_status_check;
ALTER TABLE outbound_sends ADD CONSTRAINT outbound_sends_status_check
  CHECK (status IN ('sending', 'accepted', 'sandbox', 'failed', 'uncertain', 'blocked', 'queued'));

CREATE INDEX IF NOT EXISTS outbound_sends_queued_idx
  ON outbound_sends (queued_at) WHERE status = 'queued';
