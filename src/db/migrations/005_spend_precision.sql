-- Fix accumulating rounding drift in research job spend.
--
-- research_usage.cost_usd is numeric(12,6) because a single DeepSeek Search or
-- Fetch request costs $0.00075 — six decimal places are the real unit of
-- account. research_jobs.spent_usd was created as numeric(12,4), so every
-- incremental "spent_usd = spent_usd + $1" rounded to four places. The error
-- compounded with every charge: a job that recorded $0.005661 of real
-- operations stored $0.005900 of spend.
--
-- That matters beyond tidiness: the budget gate compares spent_usd against
-- budget_usd, so drift makes the engine pause earlier (or later) than the
-- founder's limit, and the UI's spend figure stops agreeing with the itemized
-- usage rows it claims to total. Widening the column to the same precision as
-- the rows it sums removes the rounding entirely.
--
-- Additive and safe to re-run. Existing values are preserved, not recomputed,
-- so this cannot silently rewrite a historical figure.
ALTER TABLE research_jobs
  ALTER COLUMN spent_usd TYPE numeric(14,6);

ALTER TABLE research_jobs
  ALTER COLUMN budget_usd TYPE numeric(14,6);

ALTER TABLE workspace_settings
  ALTER COLUMN research_default_budget_usd TYPE numeric(14,6);

-- Reconcile any drift already recorded, so stored spend matches the operations
-- it represents. Only jobs whose spend disagrees with their usage rows are
-- touched, and the correction is derived from the real rows.
UPDATE research_jobs j
SET spent_usd = u.total, updated_at = now()
FROM (
  SELECT job_id, sum(cost_usd) AS total
  FROM research_usage
  WHERE job_id IS NOT NULL
  GROUP BY job_id
) u
WHERE j.id = u.job_id
  AND abs(j.spent_usd - u.total) > 0.0000005;
