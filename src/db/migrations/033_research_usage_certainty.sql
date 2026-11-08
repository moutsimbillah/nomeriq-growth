-- Preserve historical values; new calls explicitly distinguish unknown from measured zero.
-- Internal numeric placeholders are never displayed/summed as known costs when cost_known=false.
ALTER TABLE research_usage
  ADD COLUMN IF NOT EXISTS cost_known boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS tokens_known boolean NOT NULL DEFAULT true;
