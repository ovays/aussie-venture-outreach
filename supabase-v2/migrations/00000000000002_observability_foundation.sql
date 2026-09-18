-- ReachAgent V2 observability foundation. Diagnostic history only: operational
-- tables remain authoritative for lead, email, suppression, reply, and deal state.

CREATE TABLE public.workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_type text NOT NULL CHECK (workflow_type ~ '^[a-z][a-z0-9_]{1,79}$'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','partial','skipped','waiting','cancelled')),
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  trigger_task_id text,
  trigger_run_id text,
  correlation_id text,
  idempotency_key text,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  category_id uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  parent_run_id uuid REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  decision_action text,
  decision_reason_code text,
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer GENERATED ALWAYS AS (
    CASE WHEN started_at IS NOT NULL AND completed_at IS NOT NULL
      THEN floor(extract(epoch FROM (completed_at - started_at)) * 1000)::integer
      ELSE NULL END
  ) STORED,
  error_category text CHECK (error_category IS NULL OR error_category IN ('VALIDATION','DATABASE','PROVIDER','NETWORK','RATE_LIMIT','AUTH','SUPPRESSION','CONFIGURATION','CONCURRENCY','TIMEOUT','UNKNOWN')),
  error_code text,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_runs_time_order CHECK (completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at)),
  CONSTRAINT workflow_runs_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT workflow_runs_metadata_bounded CHECK (octet_length(metadata::text) <= 32768),
  CONSTRAINT workflow_runs_error_code_bounded CHECK (error_code IS NULL OR length(error_code) <= 120),
  CONSTRAINT workflow_runs_error_message_bounded CHECK (error_message IS NULL OR length(error_message) <= 1000)
);

CREATE TABLE public.workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  step_name text NOT NULL CHECK (step_name ~ '^[a-z][a-z0-9_]{1,79}$'),
  step_type text NOT NULL CHECK (step_type ~ '^[a-z][a-z0-9_]{1,79}$'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','partial','skipped','waiting','cancelled')),
  sequence integer NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer GENERATED ALWAYS AS (
    CASE WHEN started_at IS NOT NULL AND completed_at IS NOT NULL
      THEN floor(extract(epoch FROM (completed_at - started_at)) * 1000)::integer
      ELSE NULL END
  ) STORED,
  decision_action text,
  decision_reason_code text,
  provider text,
  model text,
  external_request_id text,
  external_message_id text,
  response_status text,
  input_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  total_tokens integer CHECK (total_tokens IS NULL OR total_tokens >= 0),
  estimated_cost_usd numeric(16,10) CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0),
  retryable boolean,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  error_category text CHECK (error_category IS NULL OR error_category IN ('VALIDATION','DATABASE','PROVIDER','NETWORK','RATE_LIMIT','AUTH','SUPPRESSION','CONFIGURATION','CONCURRENCY','TIMEOUT','UNKNOWN')),
  error_code text,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_steps_time_order CHECK (completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at)),
  CONSTRAINT workflow_steps_input_object CHECK (jsonb_typeof(input_summary) = 'object'),
  CONSTRAINT workflow_steps_output_object CHECK (jsonb_typeof(output_summary) = 'object'),
  CONSTRAINT workflow_steps_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT workflow_steps_summaries_bounded CHECK (
    octet_length(input_summary::text) <= 16384 AND
    octet_length(output_summary::text) <= 16384 AND
    octet_length(metadata::text) <= 32768
  ),
  CONSTRAINT workflow_steps_error_code_bounded CHECK (error_code IS NULL OR length(error_code) <= 120),
  CONSTRAINT workflow_steps_error_message_bounded CHECK (error_message IS NULL OR length(error_message) <= 1000)
);

ALTER TABLE public.ai_request_logs
  ADD COLUMN workflow_run_id uuid REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
  ADD COLUMN workflow_step_id uuid REFERENCES public.workflow_steps(id) ON DELETE SET NULL,
  ADD COLUMN provider_request_id text;

CREATE TRIGGER update_workflow_runs_updated_at
  BEFORE UPDATE ON public.workflow_runs FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_workflow_steps_updated_at
  BEFORE UPDATE ON public.workflow_steps FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Each index corresponds to a bounded admin diagnostic or correlation lookup.
CREATE INDEX workflow_runs_latest_idx ON public.workflow_runs (started_at DESC NULLS LAST, created_at DESC);
CREATE INDEX workflow_runs_failed_idx ON public.workflow_runs (started_at DESC NULLS LAST) WHERE status IN ('failed','partial');
CREATE INDEX workflow_runs_lead_idx ON public.workflow_runs (lead_id, started_at DESC NULLS LAST) WHERE lead_id IS NOT NULL;
CREATE INDEX workflow_runs_type_status_idx ON public.workflow_runs (workflow_type, status, started_at DESC NULLS LAST);
CREATE INDEX workflow_runs_decision_idx ON public.workflow_runs (decision_action, decision_reason_code, started_at DESC NULLS LAST) WHERE decision_action IS NOT NULL;
CREATE INDEX workflow_runs_trigger_run_idx ON public.workflow_runs (trigger_run_id) WHERE trigger_run_id IS NOT NULL;
CREATE INDEX workflow_runs_correlation_idx ON public.workflow_runs (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE UNIQUE INDEX workflow_runs_idempotency_attempt_uidx ON public.workflow_runs (workflow_type, idempotency_key, attempt) WHERE idempotency_key IS NOT NULL;
CREATE INDEX workflow_steps_run_idx ON public.workflow_steps (workflow_run_id, sequence, created_at);
CREATE INDEX workflow_steps_failed_idx ON public.workflow_steps (created_at DESC) WHERE status = 'failed';
CREATE INDEX workflow_steps_provider_idx ON public.workflow_steps (provider, created_at DESC) WHERE provider IS NOT NULL;
CREATE INDEX workflow_steps_decision_idx ON public.workflow_steps (decision_action, decision_reason_code, created_at DESC) WHERE decision_action IS NOT NULL;
CREATE INDEX ai_request_logs_workflow_run_idx ON public.ai_request_logs (workflow_run_id, created_at DESC) WHERE workflow_run_id IS NOT NULL;

ALTER TABLE public.workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflow_runs_admin_read ON public.workflow_runs FOR SELECT TO authenticated USING (public.is_active_admin());
CREATE POLICY workflow_steps_admin_read ON public.workflow_steps FOR SELECT TO authenticated USING (public.is_active_admin());

REVOKE ALL ON TABLE public.workflow_runs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.workflow_steps FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.workflow_runs TO authenticated;
GRANT SELECT ON TABLE public.workflow_steps TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.workflow_runs TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.workflow_steps TO service_role;
GRANT ALL ON TABLE public.workflow_runs TO reachagent_function_owner;
GRANT ALL ON TABLE public.workflow_steps TO reachagent_function_owner;

-- Bounded read surfaces. Direct table reads remain admin-only under the same RLS.
CREATE FUNCTION public.admin_workflow_runs(
  p_limit integer DEFAULT 50,
  p_workflow_type text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_lead_id uuid DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
) RETURNS SETOF public.workflow_runs
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT r.* FROM public.workflow_runs r
  WHERE (p_workflow_type IS NULL OR r.workflow_type = p_workflow_type)
    AND (p_status IS NULL OR r.status = p_status)
    AND (p_lead_id IS NULL OR r.lead_id = p_lead_id)
    AND (p_from IS NULL OR r.started_at >= p_from)
    AND (p_to IS NULL OR r.started_at < p_to)
  ORDER BY r.started_at DESC NULLS LAST, r.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
$$;

CREATE FUNCTION public.admin_workflow_run_detail(p_run_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
    'run', to_jsonb(r),
    'steps', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.sequence, s.created_at) FROM public.workflow_steps s WHERE s.workflow_run_id = r.id), '[]'::jsonb)
  ) END
  FROM public.workflow_runs r WHERE r.id = p_run_id
$$;

CREATE FUNCTION public.admin_decision_distribution(p_from timestamptz, p_to timestamptz)
RETURNS TABLE(action text, reason_code text, occurrence_count bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT s.decision_action, s.decision_reason_code, count(*)
  FROM public.workflow_steps s
  WHERE s.decision_action IS NOT NULL AND s.created_at >= p_from AND s.created_at < p_to
  GROUP BY s.decision_action, s.decision_reason_code ORDER BY count(*) DESC
$$;

CREATE FUNCTION public.admin_ai_usage_summary(p_from timestamptz, p_to timestamptz)
RETURNS TABLE(provider text, model text, request_count bigint, input_tokens bigint, output_tokens bigint, total_tokens bigint, estimated_cost_usd numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT a.provider, a.model, count(*), sum(a.input_tokens), sum(a.output_tokens), sum(a.total_tokens), sum(a.estimated_cost_usd)
  FROM public.ai_request_logs a WHERE a.created_at >= p_from AND a.created_at < p_to
  GROUP BY a.provider, a.model ORDER BY count(*) DESC
$$;

CREATE FUNCTION public.admin_provider_failure_summary(p_from timestamptz, p_to timestamptz)
RETURNS TABLE(provider text, error_category text, error_code text, failure_count bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT s.provider, s.error_category, s.error_code, count(*)
  FROM public.workflow_steps s
  WHERE s.status = 'failed' AND s.provider IS NOT NULL AND s.created_at >= p_from AND s.created_at < p_to
  GROUP BY s.provider, s.error_category, s.error_code ORDER BY count(*) DESC
$$;

REVOKE ALL ON FUNCTION public.admin_workflow_runs(integer,text,text,uuid,timestamptz,timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_workflow_run_detail(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_decision_distribution(timestamptz,timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_ai_usage_summary(timestamptz,timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_provider_failure_summary(timestamptz,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_workflow_runs(integer,text,text,uuid,timestamptz,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_workflow_run_detail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_decision_distribution(timestamptz,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_ai_usage_summary(timestamptz,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_provider_failure_summary(timestamptz,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_workflow_runs(integer,text,text,uuid,timestamptz,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_workflow_run_detail(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_decision_distribution(timestamptz,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_ai_usage_summary(timestamptz,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_provider_failure_summary(timestamptz,timestamptz) TO service_role;
