-- ReachAgent SaaS 1A: workspace-scoped hot-path indexes.
--
-- Adds composite indexes used by workspace-scoped RLS queries. Natural-key
-- unique constraints (recipient ownership, exhausted query cache, search cache,
-- category name, email lead/phase slots) are intentionally NOT repartitioned
-- here: existing SECURITY DEFINER writers and application upserts still target
-- the single-column keys. SaaS 1B repartitions those keys together with the
-- writer/upsert changes that supply workspace_id explicitly.

-- Hot-path composite indexes.
CREATE INDEX leads_workspace_status_created_at_idx
  ON public.leads (workspace_id, status, created_at DESC);
CREATE INDEX leads_workspace_city_status_created_at_idx
  ON public.leads (workspace_id, city, status, created_at DESC);
CREATE INDEX leads_workspace_category_status_created_at_idx
  ON public.leads (workspace_id, category_name, status, created_at DESC);

CREATE INDEX emails_workspace_status_created_at_id_idx
  ON public.emails (workspace_id, status, created_at DESC, id);
CREATE INDEX emails_workspace_lead_id_created_at_idx
  ON public.emails (workspace_id, lead_id, created_at);

CREATE INDEX deals_workspace_lead_id_idx
  ON public.deals (workspace_id, lead_id);

CREATE INDEX dm_queue_workspace_status_created_at_idx
  ON public.dm_queue (workspace_id, status, created_at DESC);

CREATE INDEX follow_ups_workspace_status_scheduled_at_idx
  ON public.follow_ups (workspace_id, status, scheduled_at);

CREATE INDEX categories_workspace_status_idx
  ON public.categories (workspace_id, status);

CREATE INDEX category_email_templates_workspace_category_idx
  ON public.category_email_templates (workspace_id, category_id);

CREATE INDEX category_suburb_priorities_workspace_category_idx
  ON public.category_suburb_priorities (workspace_id, category_id);

CREATE INDEX category_suburb_search_state_workspace_category_idx
  ON public.category_suburb_search_state (workspace_id, category_id);

CREATE INDEX city_suburbs_workspace_city_suburb_idx
  ON public.city_suburbs (workspace_id, city, suburb);

CREATE INDEX activity_log_workspace_event_type_created_at_idx
  ON public.activity_log (workspace_id, event_type, created_at DESC);
CREATE INDEX activity_log_workspace_lead_id_created_at_idx
  ON public.activity_log (workspace_id, lead_id, created_at DESC);

CREATE INDEX inbound_receipts_workspace_status_updated_at_idx
  ON public.inbound_receipts (workspace_id, status, updated_at);

CREATE INDEX discovery_run_metrics_workspace_run_at_idx
  ON public.discovery_run_metrics (workspace_id, run_at DESC);

CREATE INDEX exhausted_queries_workspace_city_category_idx
  ON public.exhausted_queries (workspace_id, city, category);

CREATE INDEX search_cache_workspace_created_at_idx
  ON public.search_cache (workspace_id, created_at DESC);

CREATE INDEX dead_letter_queue_workspace_created_at_idx
  ON public.dead_letter_queue (workspace_id, created_at DESC);

CREATE INDEX distributed_locks_workspace_lock_idx
  ON public.distributed_locks (workspace_id, lock_key);

CREATE INDEX lead_data_quality_flags_workspace_status_updated_idx
  ON public.lead_data_quality_flags (workspace_id, status, updated_at DESC);

CREATE INDEX recipient_outreach_owner_workspace_lead_idx
  ON public.recipient_outreach_ownership (workspace_id, owner_lead_id)
  WHERE owner_lead_id IS NOT NULL;

CREATE INDEX ai_request_logs_workspace_created_at_idx
  ON public.ai_request_logs (workspace_id, created_at DESC);
CREATE INDEX ai_request_logs_workspace_workflow_created_at_idx
  ON public.ai_request_logs (workspace_id, workflow, created_at DESC);

CREATE INDEX workflow_runs_workspace_started_at_idx
  ON public.workflow_runs (workspace_id, started_at DESC NULLS LAST);
CREATE INDEX workflow_runs_workspace_type_status_idx
  ON public.workflow_runs (workspace_id, workflow_type, status, started_at DESC NULLS LAST);

CREATE INDEX workflow_steps_workspace_run_seq_idx
  ON public.workflow_steps (workspace_id, workflow_run_id, sequence);
