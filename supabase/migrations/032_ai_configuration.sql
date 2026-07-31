-- Database-driven AI provider and workflow model configuration.
-- Phase 2 intentionally seeds Anthropic only and preserves the model assignments
-- that were previously hardcoded in the application.

CREATE TABLE ai_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_models_provider_model_unique UNIQUE (provider_id, model_key)
);

CREATE INDEX ai_models_provider_enabled_idx
  ON ai_models (provider_id)
  WHERE enabled = true;

CREATE TABLE ai_workflow_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_key TEXT UNIQUE NOT NULL,
  model_id UUID NOT NULL REFERENCES ai_models(id) ON DELETE RESTRICT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER update_ai_providers_updated_at BEFORE UPDATE ON ai_providers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_ai_models_updated_at BEFORE UPDATE ON ai_models
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_ai_workflow_configurations_updated_at
  BEFORE UPDATE ON ai_workflow_configurations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_workflow_configurations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users have full access" ON ai_providers
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users have full access" ON ai_models
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users have full access" ON ai_workflow_configurations
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON ai_providers
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON ai_models
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON ai_workflow_configurations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO ai_providers (provider_key, display_name, enabled)
VALUES ('anthropic', 'Anthropic', true);

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
    ('claude-haiku-4-5-20251001', 'Claude Haiku 4.5'),
    ('claude-sonnet-4-6', 'Claude Sonnet 4.6')
) AS model(model_key, display_name)
WHERE provider.provider_key = 'anthropic';

INSERT INTO ai_workflow_configurations (workflow_key, model_id, enabled)
SELECT
  assignment.workflow_key,
  model.id,
  true
FROM (
  VALUES
    ('website_extraction', 'claude-haiku-4-5-20251001'),
    ('contact_email_extraction', 'claude-haiku-4-5-20251001'),
    ('agentic_email_search', 'claude-sonnet-4-6'),
    ('outreach_email_generation', 'claude-sonnet-4-6'),
    ('outreach_dm_generation', 'claude-sonnet-4-6'),
    ('reactivation_email_generation', 'claude-sonnet-4-6')
) AS assignment(workflow_key, model_key)
JOIN ai_providers AS provider
  ON provider.provider_key = 'anthropic'
JOIN ai_models AS model
  ON model.provider_id = provider.id
  AND model.model_key = assignment.model_key;
