-- Z.ai GLM is a chat-only provider. No provider rows, keys or task assignments are created.
-- Preserve every existing provider; rerunning this widening does not change data.
ALTER TABLE research_providers
  DROP CONSTRAINT IF EXISTS research_providers_provider_check;
ALTER TABLE research_providers
  ADD CONSTRAINT research_providers_provider_check
  CHECK (provider IN
    ('deepseek', 'openai', 'anthropic', 'gemini',
     'openrouter', 'brave', 'custom', 'zai'));

ALTER TABLE research_providers
  DROP CONSTRAINT IF EXISTS research_providers_zai_chat_check;
ALTER TABLE research_providers
  ADD CONSTRAINT research_providers_zai_chat_check
  CHECK (provider <> 'zai' OR kinds = 'chat');
