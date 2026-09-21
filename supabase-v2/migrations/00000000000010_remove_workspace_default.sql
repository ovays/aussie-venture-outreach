-- ReachAgent SaaS 1B: remove the transitional seed-workspace fallback.
--
-- Operational writers now supply workspace_id explicitly. Keeping NOT NULL
-- while dropping every tenant-table default makes any missed writer fail
-- closed instead of silently assigning data to the seed workspace.

DO $migration$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'activity_log',
    'categories',
    'category_email_templates',
    'category_suburb_priorities',
    'category_suburb_search_state',
    'city_suburbs',
    'dead_letter_queue',
    'deals',
    'discovery_run_metrics',
    'distributed_locks',
    'dm_queue',
    'emails',
    'exhausted_queries',
    'follow_ups',
    'inbound_receipts',
    'lead_data_quality_flags',
    'leads',
    'recipient_outreach_ownership',
    'search_cache',
    'ai_request_logs',
    'workflow_runs',
    'workflow_steps'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN workspace_id DROP DEFAULT', table_name);
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN workspace_id SET NOT NULL', table_name);
  END LOOP;
END
$migration$;
