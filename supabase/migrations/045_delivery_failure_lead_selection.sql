-- Lightweight unique-lead selection for the Delivery Failures report. This
-- mirrors the active-row filters from get_delivery_failure_report without
-- returning full failure records or including lead-less historical audit rows.
CREATE OR REPLACE FUNCTION public.get_delivery_failure_lead_selection(
  p_status TEXT DEFAULT NULL,
  p_email_type TEXT DEFAULT NULL,
  p_search TEXT DEFAULT '',
  p_include_ids BOOLEAN DEFAULT FALSE
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
    pg_catalog.btrim(COALESCE(p_search, '')) AS search_term
),
eligible AS MATERIALIZED (
  SELECT emails.lead_id
  FROM public.emails AS emails
  JOIN public.leads AS leads ON leads.id = emails.lead_id
  LEFT JOIN LATERAL (
    SELECT activity_log.metadata
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
  CROSS JOIN validated
  WHERE emails.status IN ('bounced', 'failed', 'suppressed')
    AND (validated.status_filter IS NULL OR emails.status = validated.status_filter)
    AND (validated.type_filter IS NULL OR emails.type = validated.type_filter)
    AND (
      validated.search_term = ''
      OR COALESCE(leads.business_name, '') ILIKE '%' || validated.search_term || '%'
      OR COALESCE(NULLIF(provider_event.metadata ->> 'recipient', ''), leads.email, '')
        ILIKE '%' || validated.search_term || '%'
    )
),
unique_leads AS (
  SELECT DISTINCT eligible.lead_id
  FROM eligible
)
SELECT pg_catalog.jsonb_build_object(
  'count', COUNT(*),
  'lead_ids', CASE
    WHEN p_include_ids THEN COALESCE(
      pg_catalog.jsonb_agg(unique_leads.lead_id ORDER BY unique_leads.lead_id),
      '[]'::JSONB
    )
    ELSE '[]'::JSONB
  END
)
FROM unique_leads;
$function$;

REVOKE ALL ON FUNCTION public.get_delivery_failure_lead_selection(TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_delivery_failure_lead_selection(TEXT, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;
