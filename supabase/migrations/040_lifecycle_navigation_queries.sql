-- Bounded read paths for Lifecycle, Email Log, and the shared health banner.
-- This migration is additive and preserves the caller's existing RLS policies.

CREATE INDEX IF NOT EXISTS emails_created_at_id_idx
  ON public.emails (created_at DESC, id);

CREATE INDEX IF NOT EXISTS emails_status_created_at_id_idx
  ON public.emails (status, created_at DESC, id);

CREATE INDEX IF NOT EXISTS emails_type_created_at_id_idx
  ON public.emails (type, created_at DESC, id);

CREATE OR REPLACE FUNCTION public.get_lifecycle_page(
  p_as_of TIMESTAMPTZ DEFAULT now(),
  p_filter TEXT DEFAULT 'all',
  p_search TEXT DEFAULT '',
  p_sort_key TEXT DEFAULT 'next_action_date',
  p_sort_dir TEXT DEFAULT 'asc',
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
    p_as_of AS as_of,
    CASE WHEN p_filter IN ('all', 'fu1_due', 'fu2_due', 'fu3_due', 'fu1', 'fu2', 'fu3', 'fu_due', 'overdue', 'reactivation', 'awaiting_dead', 'dead') THEN p_filter ELSE 'all' END AS filter_key,
    pg_catalog.btrim(COALESCE(p_search, '')) AS search_term,
    CASE WHEN p_sort_key IN ('next_action_date', 'days_since_initial', 'stage') THEN p_sort_key ELSE 'next_action_date' END AS sort_key,
    CASE WHEN pg_catalog.lower(p_sort_dir) = 'desc' THEN 'desc' ELSE 'asc' END AS sort_dir,
    GREATEST(COALESCE(p_page, 1), 1) AS page_number,
    LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 100) AS page_size
),
settings_raw AS (
  SELECT
    MAX(settings.value) FILTER (WHERE settings.key = 'follow_up_1_days') AS fu1,
    MAX(settings.value) FILTER (WHERE settings.key = 'follow_up_2_days') AS fu2,
    MAX(settings.value) FILTER (WHERE settings.key = 'follow_up_3_days') AS fu3,
    MAX(settings.value) FILTER (WHERE settings.key = 'dead_lead_days') AS dead_days,
    MAX(settings.value) FILTER (WHERE settings.key = 'reactivation_delay_days') AS react_days,
    MAX(settings.value) FILTER (WHERE settings.key = 'dead_after_reactivation_days') AS dead_after_react,
    MAX(settings.value) FILTER (WHERE settings.key = 'reactivation_enabled') AS react_enabled
  FROM public.settings AS settings
  WHERE settings.key IN ('follow_up_1_days', 'follow_up_2_days', 'follow_up_3_days', 'dead_lead_days', 'reactivation_delay_days', 'dead_after_reactivation_days', 'reactivation_enabled')
),
settings_values AS (
  SELECT
    COALESCE((SUBSTRING(settings_raw.fu1 FROM '^[+-]?[0-9]+'))::INTEGER, 7) AS fu1,
    COALESCE((SUBSTRING(settings_raw.fu2 FROM '^[+-]?[0-9]+'))::INTEGER, 14) AS fu2,
    COALESCE((SUBSTRING(settings_raw.fu3 FROM '^[+-]?[0-9]+'))::INTEGER, 21) AS fu3,
    COALESCE((SUBSTRING(settings_raw.dead_days FROM '^[+-]?[0-9]+'))::INTEGER, 21) AS dead_days,
    COALESCE((SUBSTRING(settings_raw.react_days FROM '^[+-]?[0-9]+'))::INTEGER, 60) AS react_days,
    COALESCE((SUBSTRING(settings_raw.dead_after_react FROM '^[+-]?[0-9]+'))::INTEGER, 14) AS dead_after_react,
    COALESCE(settings_raw.react_enabled = 'true', FALSE) AS react_enabled
  FROM settings_raw
),
recent_dead AS MATERIALIZED (
  SELECT leads.id
  FROM public.leads AS leads
  WHERE leads.status = 'dead'
  ORDER BY leads.created_at DESC, leads.id ASC
  LIMIT 200
),
candidate_leads AS MATERIALIZED (
  SELECT leads.*
  FROM public.leads AS leads
  WHERE leads.status = 'contacted'
  UNION ALL
  SELECT leads.*
  FROM public.leads AS leads
  JOIN recent_dead ON recent_dead.id = leads.id
),
email_events AS MATERIALIZED (
  SELECT
    leads.id AS lead_id,
    (ARRAY_AGG(emails.sent_at ORDER BY emails.created_at, emails.id) FILTER (WHERE emails.type = 'initial_pitch' AND emails.sent_at IS NOT NULL))[1] AS initial_sent_at,
    COALESCE(BOOL_OR(emails.sent_at IS NOT NULL) FILTER (WHERE emails.type = 'follow_up_1'), FALSE) AS fu1_sent,
    COALESCE(BOOL_OR(emails.sent_at IS NOT NULL) FILTER (WHERE emails.type = 'follow_up_2'), FALSE) AS fu2_sent,
    COALESCE(BOOL_OR(emails.sent_at IS NOT NULL) FILTER (WHERE emails.type = 'follow_up_3'), FALSE) AS fu3_sent
  FROM candidate_leads AS leads
  LEFT JOIN public.emails AS emails ON emails.lead_id = leads.id
  WHERE leads.email IS NOT NULL AND leads.email <> ''
  GROUP BY leads.id
),
facts AS MATERIALIZED (
  SELECT
    leads.id,
    leads.business_name,
    leads.email,
    leads.status,
    leads.reactivation_sent_at,
    email_events.initial_sent_at,
    email_events.fu1_sent,
    email_events.fu2_sent,
    email_events.fu3_sent,
    CASE WHEN email_events.initial_sent_at IS NULL THEN NULL ELSE FLOOR(EXTRACT(EPOCH FROM (validated.as_of - email_events.initial_sent_at)) / 86400)::INTEGER END AS days_since_initial,
    CASE WHEN leads.reactivation_sent_at IS NULL THEN NULL ELSE FLOOR(EXTRACT(EPOCH FROM (validated.as_of - leads.reactivation_sent_at)) / 86400)::INTEGER END AS days_since_reactivation,
    CASE WHEN NOT email_events.fu1_sent THEN 'follow_up_1' WHEN NOT email_events.fu2_sent THEN 'follow_up_2' WHEN NOT email_events.fu3_sent THEN 'follow_up_3' ELSE NULL END AS next_follow_up
  FROM candidate_leads AS leads
  JOIN email_events ON email_events.lead_id = leads.id
  CROSS JOIN validated
),
classified AS MATERIALIZED (
  SELECT
    facts.id,
    facts.business_name,
    facts.email,
    CASE
      WHEN facts.status = 'dead' THEN 'Dead'
      WHEN facts.reactivation_sent_at IS NOT NULL AND facts.days_since_reactivation >= settings_values.dead_after_react THEN 'Awaiting Dead'
      WHEN facts.reactivation_sent_at IS NOT NULL THEN 'Reactivated'
      WHEN facts.initial_sent_at IS NULL THEN 'Unknown'
      WHEN facts.next_follow_up = 'follow_up_3' THEN 'Follow-up 2 Sent'
      WHEN facts.next_follow_up IS NULL AND settings_values.react_enabled AND facts.days_since_initial >= settings_values.react_days THEN 'Reactivation Due'
      WHEN facts.next_follow_up IS NULL THEN 'Follow-up 3 Sent'
      WHEN facts.next_follow_up = 'follow_up_2' THEN 'Follow-up 1 Sent'
      ELSE 'Initial Sent'
    END AS stage,
    CASE
      WHEN facts.status = 'dead' THEN 'None'
      WHEN facts.reactivation_sent_at IS NOT NULL THEN 'Mark Dead'
      WHEN facts.initial_sent_at IS NULL THEN 'None'
      WHEN facts.next_follow_up = 'follow_up_3' THEN 'Send Follow-up 3'
      WHEN facts.next_follow_up IS NULL AND settings_values.react_enabled THEN 'Send Reactivation'
      WHEN facts.next_follow_up IS NULL THEN 'Mark Dead'
      WHEN facts.next_follow_up = 'follow_up_2' THEN 'Send Follow-up 2'
      ELSE 'Send Follow-up 1'
    END AS next_action,
    CASE
      WHEN facts.status = 'dead' THEN NULL
      WHEN facts.reactivation_sent_at IS NOT NULL THEN facts.reactivation_sent_at + pg_catalog.make_interval(days => settings_values.dead_after_react)
      WHEN facts.initial_sent_at IS NULL THEN NULL
      WHEN facts.next_follow_up = 'follow_up_3' THEN facts.initial_sent_at + pg_catalog.make_interval(days => settings_values.fu3)
      WHEN facts.next_follow_up IS NULL AND settings_values.react_enabled THEN facts.initial_sent_at + pg_catalog.make_interval(days => settings_values.react_days)
      WHEN facts.next_follow_up IS NULL THEN facts.initial_sent_at + pg_catalog.make_interval(days => settings_values.dead_days)
      WHEN facts.next_follow_up = 'follow_up_2' THEN facts.initial_sent_at + pg_catalog.make_interval(days => settings_values.fu2)
      ELSE facts.initial_sent_at + pg_catalog.make_interval(days => settings_values.fu1)
    END AS next_action_date,
    facts.days_since_initial,
    CASE
      WHEN facts.status = 'dead' THEN 'dead'
      WHEN facts.reactivation_sent_at IS NOT NULL THEN 'reactivation'
      WHEN facts.initial_sent_at IS NULL THEN 'none'
      WHEN facts.next_follow_up = 'follow_up_3' THEN 'fu3'
      WHEN facts.next_follow_up IS NULL AND settings_values.react_enabled THEN 'reactivation'
      WHEN facts.next_follow_up IS NULL THEN 'none'
      WHEN facts.next_follow_up = 'follow_up_2' THEN 'fu2'
      ELSE 'fu1'
    END AS lifecycle_filter,
    CASE
      WHEN facts.status = 'dead' THEN FALSE
      WHEN facts.reactivation_sent_at IS NOT NULL THEN facts.days_since_reactivation >= settings_values.dead_after_react
      WHEN facts.initial_sent_at IS NULL THEN FALSE
      WHEN facts.next_follow_up = 'follow_up_3' THEN facts.days_since_initial >= settings_values.fu3
      WHEN facts.next_follow_up IS NULL AND settings_values.react_enabled THEN facts.days_since_initial >= settings_values.react_days
      WHEN facts.next_follow_up IS NULL THEN facts.days_since_initial >= settings_values.dead_days
      WHEN facts.next_follow_up = 'follow_up_2' THEN facts.days_since_initial >= settings_values.fu2
      ELSE facts.days_since_initial >= settings_values.fu1
    END AS is_overdue
  FROM facts
  CROSS JOIN settings_values
),
counts AS (
  SELECT
    COUNT(*)::BIGINT AS all_count,
    COUNT(*) FILTER (WHERE lifecycle_filter IN ('fu1', 'fu2', 'fu3') AND is_overdue)::BIGINT AS fu_due,
    COUNT(*) FILTER (WHERE lifecycle_filter = 'fu1' AND is_overdue)::BIGINT AS fu1_due,
    COUNT(*) FILTER (WHERE lifecycle_filter = 'fu2' AND is_overdue)::BIGINT AS fu2_due,
    COUNT(*) FILTER (WHERE lifecycle_filter = 'fu3' AND is_overdue)::BIGINT AS fu3_due,
    COUNT(*) FILTER (WHERE lifecycle_filter = 'fu1')::BIGINT AS fu1,
    COUNT(*) FILTER (WHERE lifecycle_filter = 'fu2')::BIGINT AS fu2,
    COUNT(*) FILTER (WHERE lifecycle_filter = 'fu3')::BIGINT AS fu3,
    COUNT(*) FILTER (WHERE is_overdue)::BIGINT AS overdue,
    COUNT(*) FILTER (WHERE lifecycle_filter = 'reactivation' AND stage <> 'Awaiting Dead')::BIGINT AS reactivation,
    COUNT(*) FILTER (WHERE stage = 'Awaiting Dead')::BIGINT AS awaiting_dead,
    COUNT(*) FILTER (WHERE lifecycle_filter = 'dead')::BIGINT AS dead
  FROM classified
),
matched AS MATERIALIZED (
  SELECT classified.*
  FROM classified
  CROSS JOIN validated
  WHERE
    (validated.search_term = ''
      OR classified.business_name ILIKE '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(validated.search_term, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%' ESCAPE E'\\'
      OR classified.email ILIKE '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(validated.search_term, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%' ESCAPE E'\\')
    AND CASE validated.filter_key
      WHEN 'fu_due' THEN classified.lifecycle_filter IN ('fu1', 'fu2', 'fu3') AND classified.is_overdue
      WHEN 'fu1_due' THEN classified.lifecycle_filter = 'fu1' AND classified.is_overdue
      WHEN 'fu2_due' THEN classified.lifecycle_filter = 'fu2' AND classified.is_overdue
      WHEN 'fu3_due' THEN classified.lifecycle_filter = 'fu3' AND classified.is_overdue
      WHEN 'overdue' THEN classified.is_overdue
      WHEN 'fu1' THEN classified.lifecycle_filter = 'fu1'
      WHEN 'fu2' THEN classified.lifecycle_filter = 'fu2'
      WHEN 'fu3' THEN classified.lifecycle_filter = 'fu3'
      WHEN 'reactivation' THEN classified.lifecycle_filter = 'reactivation' AND classified.stage <> 'Awaiting Dead'
      WHEN 'awaiting_dead' THEN classified.stage = 'Awaiting Dead'
      WHEN 'dead' THEN classified.lifecycle_filter = 'dead'
      ELSE TRUE
    END
),
paged AS (
  SELECT matched.*
  FROM matched
  CROSS JOIN validated
  ORDER BY
    CASE WHEN validated.sort_key = 'next_action_date' AND validated.sort_dir = 'asc' THEN matched.next_action_date END ASC NULLS LAST,
    CASE WHEN validated.sort_key = 'next_action_date' AND validated.sort_dir = 'desc' THEN matched.next_action_date END DESC NULLS FIRST,
    CASE WHEN validated.sort_key = 'days_since_initial' AND validated.sort_dir = 'asc' THEN COALESCE(matched.days_since_initial, -1) END ASC,
    CASE WHEN validated.sort_key = 'days_since_initial' AND validated.sort_dir = 'desc' THEN COALESCE(matched.days_since_initial, -1) END DESC,
    CASE WHEN validated.sort_key = 'stage' AND validated.sort_dir = 'asc' THEN matched.stage END ASC,
    CASE WHEN validated.sort_key = 'stage' AND validated.sort_dir = 'desc' THEN matched.stage END DESC,
    matched.id ASC
  OFFSET ((SELECT page_number - 1 FROM validated) * (SELECT page_size FROM validated))
  LIMIT (SELECT page_size FROM validated)
),
records AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', paged.id,
    'business_name', paged.business_name,
    'email', paged.email,
    'stage', paged.stage,
    'days_since_initial', paged.days_since_initial,
    'next_action', paged.next_action,
    'next_action_date', paged.next_action_date,
    'filter_key', paged.lifecycle_filter,
    'is_overdue', paged.is_overdue
  ) ORDER BY
    CASE WHEN validated.sort_key = 'next_action_date' AND validated.sort_dir = 'asc' THEN paged.next_action_date END ASC NULLS LAST,
    CASE WHEN validated.sort_key = 'next_action_date' AND validated.sort_dir = 'desc' THEN paged.next_action_date END DESC NULLS FIRST,
    CASE WHEN validated.sort_key = 'days_since_initial' AND validated.sort_dir = 'asc' THEN COALESCE(paged.days_since_initial, -1) END ASC,
    CASE WHEN validated.sort_key = 'days_since_initial' AND validated.sort_dir = 'desc' THEN COALESCE(paged.days_since_initial, -1) END DESC,
    CASE WHEN validated.sort_key = 'stage' AND validated.sort_dir = 'asc' THEN paged.stage END ASC,
    CASE WHEN validated.sort_key = 'stage' AND validated.sort_dir = 'desc' THEN paged.stage END DESC,
    paged.id ASC
  ), '[]'::JSONB) AS rows
  FROM paged
  CROSS JOIN validated
),
dead_today AS (
  SELECT COUNT(*)::BIGINT AS count
  FROM public.activity_log
  CROSS JOIN validated
  WHERE event_type = 'lead_marked_dead'
    AND created_at >= ((validated.as_of AT TIME ZONE 'Australia/Sydney')::DATE::TIMESTAMP AT TIME ZONE 'Australia/Sydney')
    AND created_at < ((((validated.as_of AT TIME ZONE 'Australia/Sydney')::DATE + 1)::TIMESTAMP) AT TIME ZONE 'Australia/Sydney')
)
SELECT pg_catalog.jsonb_build_object(
  'data', records.rows,
  'total', (SELECT COUNT(*) FROM matched),
  'page', validated.page_number,
  'page_size', validated.page_size,
  'counts', pg_catalog.jsonb_build_object('all', counts.all_count, 'fu_due', counts.fu_due, 'fu1_due', counts.fu1_due, 'fu2_due', counts.fu2_due, 'fu3_due', counts.fu3_due, 'fu1', counts.fu1, 'fu2', counts.fu2, 'fu3', counts.fu3, 'overdue', counts.overdue, 'reactivation', counts.reactivation, 'awaiting_dead', counts.awaiting_dead, 'dead', counts.dead),
  'summary', pg_catalog.jsonb_build_object('fu1_due', counts.fu1_due, 'fu2_due', counts.fu2_due, 'fu3_due', counts.fu3_due, 'reactivation_due', (SELECT COUNT(*) FROM classified WHERE stage = 'Reactivation Due'), 'awaiting_dead', counts.awaiting_dead, 'dead_today', dead_today.count)
)
FROM validated CROSS JOIN counts CROSS JOIN records CROSS JOIN dead_today;
$function$;

CREATE OR REPLACE FUNCTION public.get_email_log_summary(
  p_type TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_search TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
WITH validated AS (
  SELECT pg_catalog.btrim(COALESCE(p_search, '')) AS search_term
), lead_counts AS (
  SELECT
    COUNT(*) FILTER (WHERE leads.status IN ('contacted', 'replied', 'negotiating', 'interested', 'closed', 'closed_won', 'closed_manual', 'dead'))::BIGINT AS contacted,
    COUNT(*) FILTER (WHERE leads.status IN ('replied', 'negotiating', 'interested', 'closed', 'closed_won', 'closed_manual'))::BIGINT AS positive
  FROM public.leads AS leads
), legacy_bounded_email_rows AS (
  SELECT emails.status
  FROM public.emails AS emails
  CROSS JOIN validated
  WHERE (p_type IS NULL OR emails.type = p_type)
    AND (p_status IS NULL OR emails.status = p_status)
    AND (validated.search_term = '' OR emails.subject ILIKE '%' || validated.search_term || '%')
  ORDER BY emails.created_at DESC, emails.id ASC
  LIMIT 500
), bounce_count AS (
  SELECT COUNT(*) FILTER (WHERE legacy_bounded_email_rows.status = 'bounced')::BIGINT AS bounced
  FROM legacy_bounded_email_rows
)
SELECT pg_catalog.jsonb_build_object(
  'total_contacted_leads', lead_counts.contacted,
  'positive_response_leads', lead_counts.positive,
  'reply_rate', CASE WHEN lead_counts.contacted > 0 THEN pg_catalog.round(lead_counts.positive::NUMERIC / lead_counts.contacted::NUMERIC * 100)::INTEGER ELSE 0 END,
  'matching_bounced', bounce_count.bounced
)
FROM lead_counts CROSS JOIN bounce_count;
$function$;

CREATE OR REPLACE FUNCTION public.get_health_summary(p_as_of TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
WITH latest_finder AS (
  SELECT activity_log.created_at FROM public.activity_log WHERE activity_log.event_type = 'finder_complete' ORDER BY activity_log.created_at DESC LIMIT 1
), latest_cost_guard AS (
  SELECT activity_log.created_at, activity_log.metadata FROM public.activity_log WHERE activity_log.event_type = 'cost_guard_triggered' AND activity_log.created_at >= p_as_of - INTERVAL '2 hours' ORDER BY activity_log.created_at DESC LIMIT 1
), agent_errors AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('description', bounded.description, 'metadata', bounded.metadata, 'created_at', bounded.created_at) ORDER BY bounded.created_at DESC), '[]'::JSONB) AS rows
  FROM (SELECT activity_log.description, activity_log.metadata, activity_log.created_at FROM public.activity_log WHERE activity_log.event_type = 'agent_error' AND activity_log.created_at >= p_as_of - INTERVAL '25 hours' ORDER BY activity_log.created_at DESC LIMIT 5) AS bounded
)
SELECT pg_catalog.jsonb_build_object(
  'system_active', (SELECT settings.value FROM public.settings WHERE settings.key = 'system_active' LIMIT 1),
  'last_pipeline_run', (SELECT latest_finder.created_at FROM latest_finder),
  'outscraper_error', EXISTS (SELECT 1 FROM public.activity_log WHERE created_at >= p_as_of - INTERVAL '24 hours' AND (description ILIKE '%402%' OR description ILIKE '%quota exhausted%' OR description ILIKE '%balance%')),
  'bounce_count', (SELECT COUNT(*) FROM public.emails WHERE status = 'bounced' AND sent_at >= p_as_of - INTERVAL '24 hours'),
  'cost_guard', (SELECT pg_catalog.jsonb_build_object('created_at', latest_cost_guard.created_at, 'metadata', latest_cost_guard.metadata) FROM latest_cost_guard),
  'agent_errors', agent_errors.rows,
  'dead_letter_count', (SELECT COUNT(*) FROM public.dead_letter_queue WHERE resolved = FALSE AND created_at >= p_as_of - INTERVAL '24 hours')
)
FROM agent_errors;
$function$;

REVOKE ALL ON FUNCTION public.get_lifecycle_page(TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_email_log_summary(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_health_summary(TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_lifecycle_page(TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_email_log_summary(TEXT, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_health_summary(TIMESTAMPTZ) TO authenticated, service_role;
