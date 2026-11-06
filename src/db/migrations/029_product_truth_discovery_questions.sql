-- 029_product_truth_discovery_questions.sql
-- Product Truth gains "Questions to ask prospects": the discovery questions the founder wants every
-- AI writer to draw on (and connected assistants to read), kept beside the claims they qualify.
--
-- Additive and safe to re-run: one new column with an empty-list default. Existing Product Truth
-- content, its version, status and approval are not touched; the founder fills the questions in.

ALTER TABLE product_truth
  ADD COLUMN IF NOT EXISTS discovery_questions jsonb NOT NULL DEFAULT '[]'::jsonb;
