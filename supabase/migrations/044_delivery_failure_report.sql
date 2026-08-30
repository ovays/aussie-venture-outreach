-- Bounded reporting for terminal delivery failures. The expression index is
-- intentionally partial: only Prompt 1's provider terminal events need to be
-- correlated to emails by the historical email id stored in JSON metadata.
CREATE INDEX IF NOT EXISTS activity_log_delivery_email_created_at_idx
  ON public.activity_log ((metadata ->> 'email_id'), created_at DESC)
  WHERE event_type = 'delivery_terminal_failure';

CREATE OR REPLACE FUNCTION public.get_delivery_failure_report(
  p_status TEXT DEFAULT NULL,
  p_email_type TEXT DEFAULT NULL,
  p_search TEXT DEFAULT '',
  p_page INTEGER DEFAULT 1,
  p_page_size INTEGER DEFAULT 50
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
WITH
validated AS (
  SELECT
    CASE WHEN p_status IN ('bounced', 'failed', 'suppressed') THEN p_status ELSE NULL END AS status_filter,
    CASE WHEN p_email_type IN ('initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'reactivation') THEN p_email_type ELSE NULL END AS type_filter,
    pg_catalog.btrim(COALESCE(p_search, '')) AS search_term,
    GREATEST(COALESCE(p_page, 1), 1) AS page_number,
    LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 100) AS page_size
),
current_failures AS MATERIALIZED (
  SELECT
    emails.id::TEXT AS email_id,
    emails.lead_id,
    emails.type AS email_type,
    emails.status AS failure_status,
    emails.resend_id,
    COALESCE(provider_event.created_at, emails.sent_at, emails.created_at) AS failure_date,
    provider_event.metadata AS failure_metadata,
    leads.business_name,
    leads.category_name,
    leads.city,
    leads.email AS current_email,
    COALESCE(NULLIF(provider_event.metadata ->> 'recipient', ''), leads.email) AS recipient,
    provider_event.id IS NOT NULL AS has_provider_event
  FROM public.emails AS emails
  LEFT JOIN public.leads AS leads ON leads.id = emails.lead_id
  LEFT JOIN LATERAL (
    SELECT activity_log.id, activity_log.created_at, activity_log.metadata
    FROM public.activity_log AS activity_log
    WHERE activity_log.event_type = 'delivery_terminal_failure'
      AND activity_log.metadata ->> 'email_id' = emails.id::TEXT
      AND COALESCE(
        activity_log.metadata ->> 'persisted_status',
        activity_log.metadata ->> 'provider_status'
      ) = emails.status
    ORDER BY activity_log.created_at DESC, activity_log.id DESC
    LIMIT 1
  ) AS provider_event ON TRUE
  WHERE emails.status IN ('bounced', 'failed', 'suppressed')
),
historical_provider_events AS MATERIALIZED (
  -- Prompt 1 makes terminal states absorbing, so the first provider terminal
  -- event is the status that was persisted. Collapse webhook retries and any
  -- later weaker terminal event to one historical row per email.
  SELECT DISTINCT ON (activity_log.metadata ->> 'email_id')
    activity_log.id,
    activity_log.created_at,
    activity_log.metadata
  FROM public.activity_log AS activity_log
  WHERE activity_log.event_type = 'delivery_terminal_failure'
    AND activity_log.lead_id IS NULL
    AND activity_log.metadata ->> 'email_id' IS NOT NULL
    AND activity_log.metadata ->> 'provider_status' IN ('bounced', 'failed', 'suppressed')
    AND activity_log.metadata ->> 'email_type' IN ('initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'reactivation')
    AND NOT EXISTS (
      SELECT 1
      FROM public.emails AS emails
      WHERE emails.id::TEXT = activity_log.metadata ->> 'email_id'
    )
  ORDER BY
    activity_log.metadata ->> 'email_id',
    activity_log.created_at ASC,
    activity_log.id ASC
),
historical_failures AS MATERIALIZED (
  SELECT
    historical_provider_events.metadata ->> 'email_id' AS email_id,
    NULL::UUID AS lead_id,
    historical_provider_events.metadata ->> 'email_type' AS email_type,
    COALESCE(
      historical_provider_events.metadata ->> 'persisted_status',
      historical_provider_events.metadata ->> 'provider_status'
    ) AS failure_status,
    historical_provider_events.metadata ->> 'resend_id' AS resend_id,
    historical_provider_events.created_at AS failure_date,
    historical_provider_events.metadata AS failure_metadata,
    NULL::TEXT AS business_name,
    NULL::TEXT AS category_name,
    NULL::TEXT AS city,
    NULL::TEXT AS current_email,
    NULLIF(historical_provider_events.metadata ->> 'recipient', '') AS recipient,
    TRUE AS has_provider_event
  FROM historical_provider_events
),
all_failures AS MATERIALIZED (
  SELECT * FROM current_failures
  UNION ALL
  SELECT * FROM historical_failures
),
failures AS MATERIALIZED (
  SELECT all_failures.*
  FROM all_failures
  CROSS JOIN validated
  WHERE (validated.status_filter IS NULL OR all_failures.failure_status = validated.status_filter)
    AND (validated.type_filter IS NULL OR all_failures.email_type = validated.type_filter)
    AND (
      validated.search_term = ''
      OR COALESCE(all_failures.business_name, '') ILIKE '%' || validated.search_term || '%'
      OR COALESCE(all_failures.recipient, '') ILIKE '%' || validated.search_term || '%'
    )
),
summary AS (
  SELECT
    COUNT(*)::BIGINT AS total,
    COUNT(*) FILTER (WHERE failure_status = 'bounced')::BIGINT AS bounced,
    COUNT(*) FILTER (WHERE failure_status = 'failed')::BIGINT AS failed,
    COUNT(*) FILTER (WHERE failure_status = 'suppressed')::BIGINT AS suppressed
  FROM failures
),
paged AS (
  SELECT failures.*
  FROM failures
  ORDER BY failures.failure_date DESC, failures.email_id ASC
  OFFSET (SELECT (page_number - 1) * page_size FROM validated)
  LIMIT (SELECT page_size FROM validated)
),
rows AS (
  SELECT COALESCE(
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(paged) ORDER BY paged.failure_date DESC, paged.email_id ASC),
    '[]'::JSONB
  ) AS data
  FROM paged
)
SELECT pg_catalog.jsonb_build_object(
  'data', rows.data,
  'total', summary.total,
  'page', validated.page_number,
  'page_size', validated.page_size,
  'summary', pg_catalog.jsonb_build_object(
    'total', summary.total,
    'bounced', summary.bounced,
    'failed', summary.failed,
    'suppressed', summary.suppressed
  )
)
FROM rows
CROSS JOIN summary
CROSS JOIN validated;
$function$;

REVOKE ALL ON FUNCTION public.get_delivery_failure_report(TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_delivery_failure_report(TEXT, TEXT, TEXT, INTEGER, INTEGER) TO authenticated, service_role;
