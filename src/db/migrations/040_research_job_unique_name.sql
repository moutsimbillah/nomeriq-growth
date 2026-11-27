-- One name per live research target.
--
-- The create form used to pre-fill the same batch name, so the founder ended up with several
-- targets called "Batch 02 — new commercial signal providers" and could not tell them apart.
-- The rule is applied in a partial index because rows created before it exist under duplicate
-- names and must stay readable; the application refuses a duplicate against every row, archived
-- ones included, with a message naming the target that already holds the name.
--
-- Additive and safe to re-run: it only adds an index and never rewrites a row.
CREATE UNIQUE INDEX IF NOT EXISTS research_jobs_live_name_uidx
  ON research_jobs (lower(regexp_replace(btrim(name), '\s+', ' ', 'g')))
  WHERE status IN ('active', 'paused');
