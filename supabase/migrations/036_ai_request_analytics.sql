-- Provider-independent AI request observability. Prompts and generated content
-- are deliberately excluded from this schema.

CREATE TABLE ai_request_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  workflow TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  input_tokens INTEGER CHECK (input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens >= 0),
  estimated_cost_usd NUMERIC(16, 10) CHECK (estimated_cost_usd >= 0),
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  request_source TEXT NOT NULL DEFAULT 'application',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ai_request_logs_time_order CHECK (finished_at >= started_at),
  CONSTRAINT ai_request_logs_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX ai_request_logs_created_at_idx
  ON ai_request_logs (created_at DESC);
CREATE INDEX ai_request_logs_workflow_created_at_idx
  ON ai_request_logs (workflow, created_at DESC);
CREATE INDEX ai_request_logs_provider_created_at_idx
  ON ai_request_logs (provider, created_at DESC);
CREATE INDEX ai_request_logs_status_created_at_idx
  ON ai_request_logs (status, created_at DESC);

ALTER TABLE ai_request_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read AI request logs" ON ai_request_logs
  FOR SELECT TO authenticated
  USING (public.is_active_admin());

CREATE POLICY "Service role can manage AI request logs" ON ai_request_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT ON ai_request_logs TO authenticated;
GRANT SELECT, INSERT ON ai_request_logs TO service_role;

CREATE OR REPLACE FUNCTION public.get_ai_request_analytics(
  p_start_at TIMESTAMPTZ DEFAULT NULL,
  p_end_at TIMESTAMPTZ DEFAULT NULL,
  p_workflow TEXT DEFAULT NULL,
  p_provider TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_recent_limit INTEGER DEFAULT 50
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filtered AS MATERIALIZED (
    SELECT *
    FROM public.ai_request_logs
    WHERE (auth.role() = 'service_role' OR public.is_active_admin())
      AND (p_start_at IS NULL OR created_at >= p_start_at)
      AND (p_end_at IS NULL OR created_at < p_end_at)
      AND (p_workflow IS NULL OR workflow = p_workflow)
      AND (p_provider IS NULL OR provider = p_provider)
      AND (p_status IS NULL OR status = p_status)
  ),
  summary AS (
    SELECT
      count(*) AS total_requests,
      count(*) FILTER (WHERE status = 'succeeded') AS successful_requests,
      count(*) FILTER (WHERE status = 'failed') AS failed_requests,
      avg(duration_ms) AS average_latency_ms,
      avg(estimated_cost_usd) AS average_cost_usd,
      count(*) FILTER (
        WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Australia/Sydney')
          AT TIME ZONE 'Australia/Sydney'
      ) AS requests_today,
      count(*) FILTER (
        WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Australia/Sydney')
          AT TIME ZONE 'Australia/Sydney'
      ) AS requests_this_month
    FROM filtered
  )
  SELECT jsonb_build_object(
    'summary', jsonb_build_object(
      'totalRequests', summary.total_requests,
      'successfulRequests', summary.successful_requests,
      'failedRequests', summary.failed_requests,
      'successRate', CASE
        WHEN summary.total_requests = 0 THEN 0
        ELSE round(summary.successful_requests::numeric * 100 / summary.total_requests, 2)
      END,
      'averageLatencyMs', round(COALESCE(summary.average_latency_ms, 0), 2),
      'averageCostUsd', CASE
        WHEN summary.average_cost_usd IS NULL THEN NULL
        ELSE round(summary.average_cost_usd, 8)
      END,
      'requestsToday', summary.requests_today,
      'requestsThisMonth', summary.requests_this_month
    ),
    'topWorkflows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', workflow, 'count', request_count))
      FROM (
        SELECT workflow, count(*) AS request_count
        FROM filtered GROUP BY workflow
        ORDER BY request_count DESC, workflow LIMIT 10
      ) ranked
    ), '[]'::jsonb),
    'topModels', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', model, 'count', request_count))
      FROM (
        SELECT model, count(*) AS request_count
        FROM filtered WHERE model IS NOT NULL GROUP BY model
        ORDER BY request_count DESC, model LIMIT 10
      ) ranked
    ), '[]'::jsonb),
    'topProviders', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', provider, 'count', request_count))
      FROM (
        SELECT provider, count(*) AS request_count
        FROM filtered WHERE provider IS NOT NULL GROUP BY provider
        ORDER BY request_count DESC, provider LIMIT 10
      ) ranked
    ), '[]'::jsonb),
    'recentRequests', COALESCE((
      SELECT jsonb_agg(to_jsonb(recent))
      FROM (
        SELECT
          id,
          created_at AS "createdAt",
          workflow,
          provider,
          model,
          status,
          duration_ms AS "durationMs",
          input_tokens AS "inputTokens",
          output_tokens AS "outputTokens",
          total_tokens AS "totalTokens",
          estimated_cost_usd AS "estimatedCostUsd",
          error_message AS "errorMessage",
          retry_count AS "retryCount",
          request_source AS "requestSource"
        FROM filtered
        ORDER BY created_at DESC
        LIMIT LEAST(GREATEST(p_recent_limit, 1), 100)
      ) recent
    ), '[]'::jsonb)
  )
  FROM summary;
$$;

REVOKE ALL ON FUNCTION public.get_ai_request_analytics(
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTEGER
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_ai_request_analytics(
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTEGER
) TO authenticated, service_role;
