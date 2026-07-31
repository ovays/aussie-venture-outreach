-- Add OpenAI to the AI provider catalog without changing any existing
-- Anthropic provider, model, or workflow assignment.

INSERT INTO ai_providers (provider_key, display_name, enabled)
VALUES ('openai', 'OpenAI', true);

INSERT INTO ai_models (
  provider_id,
  model_key,
  display_name,
  enabled
)
SELECT
  provider.id,
  model.model_key,
  model.display_name,
  true
FROM ai_providers AS provider
CROSS JOIN (
  VALUES
    ('gpt-5', 'GPT-5'),
    ('gpt-5-mini', 'GPT-5 Mini')
) AS model(model_key, display_name)
WHERE provider.provider_key = 'openai';
