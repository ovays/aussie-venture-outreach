-- Read-only query foundations for the existing Leads, Dashboard, Lifecycle,
-- and lead-drawer access patterns. This migration is intentionally additive.

-- Leads list: equality on status, followed by newest-first creation order.
CREATE INDEX IF NOT EXISTS leads_status_created_at_idx
  ON public.leads (status, created_at DESC);

-- Leads list: equality on city and status, followed by newest-first creation
-- order. The city-leading index is separate because the status-leading index
-- cannot efficiently satisfy this ordering after an additional city filter.
CREATE INDEX IF NOT EXISTS leads_city_status_created_at_idx
  ON public.leads (city, status, created_at DESC);

-- Lead drawer: all emails for one lead in creation order.
CREATE INDEX IF NOT EXISTS emails_lead_id_created_at_idx
  ON public.emails (lead_id, created_at);

-- Dashboard email metrics: equality on status followed by a sent-at range.
-- The range predicates imply sent_at is non-null, so omit unsent rows.
CREATE INDEX IF NOT EXISTS emails_status_sent_at_idx
  ON public.emails (status, sent_at DESC)
  WHERE sent_at IS NOT NULL;

-- Dashboard reply metrics: replied-at range over rows that have a reply.
CREATE INDEX IF NOT EXISTS emails_replied_at_idx
  ON public.emails (replied_at DESC)
  WHERE replied_at IS NOT NULL;

-- Lead drawer and retry-research: activity for one lead, newest first.
CREATE INDEX IF NOT EXISTS activity_log_lead_id_created_at_idx
  ON public.activity_log (lead_id, created_at DESC);

-- Lifecycle, health, and settings metrics: equality on event type followed by
-- a creation-date range or newest-first order.
CREATE INDEX IF NOT EXISTS activity_log_event_type_created_at_idx
  ON public.activity_log (event_type, created_at DESC);

-- Compact, exact raw-status counts for the later Dashboard query migration.
-- SECURITY INVOKER ensures the caller's existing leads RLS policies apply.
CREATE OR REPLACE FUNCTION public.get_lead_status_counts()
RETURNS TABLE (
  status TEXT,
  count BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT leads.status::TEXT, COUNT(*)::BIGINT
  FROM public.leads AS leads
  GROUP BY leads.status
  ORDER BY leads.status;
$function$;

REVOKE ALL ON FUNCTION public.get_lead_status_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_lead_status_counts() TO authenticated, service_role;
