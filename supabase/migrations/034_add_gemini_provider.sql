-- Add Gemini to the AI provider catalog without changing any existing
-- provider, model, or workflow assignment.

INSERT INTO ai_providers (provider_key, display_name, enabled)
VALUES ('gemini', 'Gemini', true);

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
    ('gemini-2.5-pro', 'Gemini 2.5 Pro'),
    ('gemini-2.5-flash', 'Gemini 2.5 Flash')
) AS model(model_key, display_name)
WHERE provider.provider_key = 'gemini';
