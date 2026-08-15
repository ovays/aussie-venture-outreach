-- Compact, read-only Dashboard summary. All calculations mirror the current
-- TypeScript Dashboard contract while keeping detailed lead/email rows in Postgres.

CREATE OR REPLACE FUNCTION public.get_dashboard_summary(
  p_as_of TIMESTAMPTZ DEFAULT now()
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
WITH
params AS (
  SELECT
    p_as_of AS as_of,
    (p_as_of AT TIME ZONE 'Australia/Sydney')::DATE AS sydney_date,
    ((p_as_of AT TIME ZONE 'Australia/Sydney')::DATE::TIMESTAMP AT TIME ZONE 'Australia/Sydney') AS today_start,
    ((((p_as_of AT TIME ZONE 'Australia/Sydney')::DATE + 1)::TIMESTAMP) AT TIME ZONE 'Australia/Sydney') AS today_end
),
settings_raw AS (
  SELECT
    MAX(settings.value) FILTER (WHERE settings.key = 'follow_up_1_days') AS follow_up_1_days,
    MAX(settings.value) FILTER (WHERE settings.key = 'follow_up_2_days') AS follow_up_2_days,
    MAX(settings.value) FILTER (WHERE settings.key = 'follow_up_3_days') AS follow_up_3_days,
    MAX(settings.value) FILTER (WHERE settings.key = 'reactivation_delay_days') AS reactivation_delay_days,
    MAX(settings.value) FILTER (WHERE settings.key = 'dead_after_reactivation_days') AS dead_after_reactivation_days,
    MAX(settings.value) FILTER (WHERE settings.key = 'reactivation_enabled') AS reactivation_enabled
  FROM public.settings AS settings
  WHERE settings.key IN (
    'follow_up_1_days',
    'follow_up_2_days',
    'follow_up_3_days',
    'reactivation_delay_days',
    'dead_after_reactivation_days',
    'reactivation_enabled'
  )
),
settings_values AS (
  SELECT
    COALESCE((SUBSTRING(settings_raw.follow_up_1_days FROM '^[+-]?[0-9]+'))::INTEGER, 7) AS follow_up_1_days,
    COALESCE((SUBSTRING(settings_raw.follow_up_2_days FROM '^[+-]?[0-9]+'))::INTEGER, 14) AS follow_up_2_days,
    COALESCE((SUBSTRING(settings_raw.follow_up_3_days FROM '^[+-]?[0-9]+'))::INTEGER, 21) AS follow_up_3_days,
    COALESCE((SUBSTRING(settings_raw.reactivation_delay_days FROM '^[+-]?[0-9]+'))::INTEGER, 60) AS reactivation_delay_days,
    COALESCE((SUBSTRING(settings_raw.dead_after_reactivation_days FROM '^[+-]?[0-9]+'))::INTEGER, 14) AS dead_after_reactivation_days,
    COALESCE(settings_raw.reactivation_enabled = 'true', FALSE) AS reactivation_enabled
  FROM settings_raw
),
status_grouped AS (
  SELECT leads.status::TEXT AS status, COUNT(*)::BIGINT AS count
  FROM public.leads AS leads
  GROUP BY leads.status
),
status_summary AS (
  SELECT
    COALESCE(pg_catalog.jsonb_object_agg(status_grouped.status, status_grouped.count) FILTER (
      WHERE status_grouped.status IS NOT NULL
    ), '{}'::JSONB) AS counts,
    COALESCE(SUM(status_grouped.count), 0)::BIGINT AS all_leads,
    COALESCE(SUM(status_grouped.count) FILTER (
      WHERE status_grouped.status IN ('contacted', 'replied', 'negotiating', 'interested', 'closed', 'closed_won', 'closed_manual', 'dead')
    ), 0)::BIGINT AS total_contacted,
    COALESCE(SUM(status_grouped.count) FILTER (
      WHERE status_grouped.status IN ('replied', 'negotiating', 'interested', 'closed', 'closed_won', 'closed_manual')
    ), 0)::BIGINT AS positive_replies
  FROM status_grouped
),
email_metrics AS (
  SELECT
    COUNT(*) FILTER (
      WHERE emails.status = 'sent'
        AND emails.sent_at >= params.today_start
        AND emails.sent_at < params.today_end
    )::BIGINT AS sent_today,
    COUNT(*) FILTER (
      WHERE emails.status = 'sent'
        AND emails.type = 'initial_pitch'
        AND emails.sent_at >= params.today_start
        AND emails.sent_at < params.today_end
    )::BIGINT AS initial_sent_today,
    COUNT(*) FILTER (
      WHERE emails.status = 'sent'
        AND emails.type = 'follow_up_1'
        AND emails.sent_at >= params.today_start
        AND emails.sent_at < params.today_end
    )::BIGINT AS follow_up_1_sent_today,
    COUNT(*) FILTER (
      WHERE emails.status = 'sent'
        AND emails.type = 'follow_up_2'
        AND emails.sent_at >= params.today_start
        AND emails.sent_at < params.today_end
    )::BIGINT AS follow_up_2_sent_today,
    COUNT(*) FILTER (
      WHERE emails.status = 'sent'
        AND emails.type = 'follow_up_3'
        AND emails.sent_at >= params.today_start
        AND emails.sent_at < params.today_end
    )::BIGINT AS follow_up_3_sent_today,
    COUNT(*) FILTER (
      WHERE emails.status = 'sent'
        AND emails.type IN ('follow_up_1', 'follow_up_2', 'follow_up_3')
    )::BIGINT AS followups_sent_total,
    COUNT(*) FILTER (
      WHERE emails.replied_at IS NOT NULL
        AND emails.replied_at >= params.today_start
        AND emails.replied_at < params.today_end
    )::BIGINT AS replies_today,
    COUNT(*) FILTER (
      WHERE emails.status = 'sent'
        AND emails.sent_at >= ((((params.sydney_date - 6)::TIMESTAMP) AT TIME ZONE 'Australia/Sydney'))
        AND emails.sent_at < params.today_end
    )::BIGINT AS emails_sent_this_week
  FROM public.emails AS emails
  CROSS JOIN params
),
contacted_email_events AS MATERIALIZED (
  SELECT
    leads.id AS lead_id,
    (ARRAY_AGG(emails.sent_at ORDER BY emails.created_at, emails.id) FILTER (
      WHERE emails.type = 'initial_pitch' AND emails.sent_at IS NOT NULL
    ))[1] AS initial_sent_at,
    COALESCE(BOOL_OR(emails.sent_at IS NOT NULL) FILTER (WHERE emails.type = 'follow_up_1'), FALSE) AS follow_up_1_sent,
    COALESCE(BOOL_OR(emails.sent_at IS NOT NULL) FILTER (WHERE emails.type = 'follow_up_2'), FALSE) AS follow_up_2_sent,
    COALESCE(BOOL_OR(emails.sent_at IS NOT NULL) FILTER (WHERE emails.type = 'follow_up_3'), FALSE) AS follow_up_3_sent
  FROM public.leads AS leads
  LEFT JOIN public.emails AS emails ON emails.lead_id = leads.id
  WHERE leads.status = 'contacted'
    AND leads.email IS NOT NULL
    AND leads.email <> ''
  GROUP BY leads.id
),
contacted_eligibility AS (
  SELECT
    leads.id AS lead_id,
    leads.reactivation_sent_at,
    contacted_email_events.initial_sent_at,
    contacted_email_events.follow_up_1_sent,
    contacted_email_events.follow_up_2_sent,
    contacted_email_events.follow_up_3_sent,
    FLOOR(EXTRACT(EPOCH FROM (params.as_of - contacted_email_events.initial_sent_at)) / 86400)::INTEGER AS days_since_initial,
    CASE
      WHEN leads.reactivation_sent_at IS NULL THEN NULL
      ELSE FLOOR(EXTRACT(EPOCH FROM (params.as_of - leads.reactivation_sent_at)) / 86400)::INTEGER
    END AS days_since_reactivation,
    CASE
      WHEN NOT contacted_email_events.follow_up_1_sent THEN 'follow_up_1'
      WHEN NOT contacted_email_events.follow_up_2_sent THEN 'follow_up_2'
      WHEN NOT contacted_email_events.follow_up_3_sent THEN 'follow_up_3'
      ELSE NULL
    END AS next_follow_up
  FROM contacted_email_events
  JOIN public.leads AS leads ON leads.id = contacted_email_events.lead_id
  CROSS JOIN params
  WHERE contacted_email_events.initial_sent_at IS NOT NULL
),
followup_summary AS (
  SELECT
    COUNT(*) FILTER (
      WHERE contacted_eligibility.next_follow_up = 'follow_up_1'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_1_days
    )::BIGINT AS pending_follow_up_1,
    COUNT(*) FILTER (
      WHERE contacted_eligibility.next_follow_up = 'follow_up_2'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_2_days
    )::BIGINT AS pending_follow_up_2,
    COUNT(*) FILTER (
      WHERE contacted_eligibility.next_follow_up = 'follow_up_3'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_3_days
    )::BIGINT AS pending_follow_up_3,
    COUNT(*) FILTER (
      WHERE contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up = 'follow_up_1'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_1_days
    )::BIGINT AS follow_up_1_due,
    COUNT(*) FILTER (
      WHERE contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up = 'follow_up_2'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_2_days
    )::BIGINT AS follow_up_2_due,
    COUNT(*) FILTER (
      WHERE contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up = 'follow_up_3'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_3_days
    )::BIGINT AS follow_up_3_due,
    COUNT(*) FILTER (
      WHERE contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up IS NULL
        AND settings_values.reactivation_enabled
      OR contacted_eligibility.reactivation_sent_at IS NOT NULL
        AND contacted_eligibility.days_since_reactivation < settings_values.dead_after_reactivation_days
    )::BIGINT AS reactivation_total,
    COUNT(*) FILTER (
      WHERE contacted_eligibility.reactivation_sent_at IS NOT NULL
        AND contacted_eligibility.days_since_reactivation >= settings_values.dead_after_reactivation_days
      OR contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up = 'follow_up_3'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_3_days
      OR contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up = 'follow_up_2'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_2_days
      OR contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up = 'follow_up_1'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_1_days
      OR contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up IS NULL
        AND settings_values.reactivation_enabled
        AND contacted_eligibility.days_since_initial >= settings_values.reactivation_delay_days
      OR contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up IS NULL
        AND NOT settings_values.reactivation_enabled
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_3_days
    )::BIGINT AS overdue_total
  FROM contacted_eligibility
  CROSS JOIN settings_values
),
daily_days AS (
  SELECT
    offsets.days_back,
    (params.sydney_date - offsets.days_back)::DATE AS activity_date,
    ((((params.sydney_date - offsets.days_back)::DATE)::TIMESTAMP) AT TIME ZONE 'Australia/Sydney') AS day_start,
    (((((params.sydney_date - offsets.days_back)::DATE) + 1)::TIMESTAMP) AT TIME ZONE 'Australia/Sydney') AS day_end
  FROM params
  CROSS JOIN pg_catalog.generate_series(0, 6) AS offsets(days_back)
),
daily_leads AS (
  SELECT
    (leads.created_at AT TIME ZONE 'Australia/Sydney')::DATE AS activity_date,
    COUNT(*)::BIGINT AS count
  FROM public.leads AS leads
  CROSS JOIN params
  WHERE leads.created_at >= ((((params.sydney_date - 6)::DATE)::TIMESTAMP) AT TIME ZONE 'Australia/Sydney')
    AND leads.created_at < params.today_end
  GROUP BY (leads.created_at AT TIME ZONE 'Australia/Sydney')::DATE
),
daily_emails AS (
  SELECT
    (emails.sent_at AT TIME ZONE 'Australia/Sydney')::DATE AS activity_date,
    COUNT(*)::BIGINT AS emails_sent,
    COUNT(*) FILTER (WHERE emails.type IN ('follow_up_1', 'follow_up_2', 'follow_up_3'))::BIGINT AS followups_sent
  FROM public.emails AS emails
  CROSS JOIN params
  WHERE emails.status = 'sent'
    AND emails.sent_at >= ((((params.sydney_date - 6)::DATE)::TIMESTAMP) AT TIME ZONE 'Australia/Sydney')
    AND emails.sent_at < params.today_end
  GROUP BY (emails.sent_at AT TIME ZONE 'Australia/Sydney')::DATE
),
daily_dms AS (
  SELECT
    (dm_queue.created_at AT TIME ZONE 'Australia/Sydney')::DATE AS activity_date,
    COUNT(*)::BIGINT AS count
  FROM public.dm_queue AS dm_queue
  CROSS JOIN params
  WHERE dm_queue.created_at >= ((((params.sydney_date - 6)::DATE)::TIMESTAMP) AT TIME ZONE 'Australia/Sydney')
    AND dm_queue.created_at < params.today_end
  GROUP BY (dm_queue.created_at AT TIME ZONE 'Australia/Sydney')::DATE
),
daily_activity AS (
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'date', daily_days.activity_date::TEXT,
        'label', CASE
          WHEN daily_days.days_back = 0 THEN 'Today (' || pg_catalog.to_char(daily_days.activity_date, 'FMDD Mon') || ')'
          WHEN daily_days.days_back = 1 THEN 'Yesterday (' || pg_catalog.to_char(daily_days.activity_date, 'FMDD Mon') || ')'
          ELSE pg_catalog.to_char(daily_days.activity_date, 'FMDD Mon')
        END,
        'leads_found', COALESCE(daily_leads.count, 0),
        'emails_sent', COALESCE(daily_emails.emails_sent, 0),
        'dms_queued', COALESCE(daily_dms.count, 0),
        'followups_sent', COALESCE(daily_emails.followups_sent, 0)
      ) ORDER BY daily_days.days_back
    ),
    '[]'::JSONB
  ) AS rows
  FROM daily_days
  LEFT JOIN daily_leads ON daily_leads.activity_date = daily_days.activity_date
  LEFT JOIN daily_emails ON daily_emails.activity_date = daily_days.activity_date
  LEFT JOIN daily_dms ON daily_dms.activity_date = daily_days.activity_date
),
dm_summary AS (
  SELECT
    COUNT(*) FILTER (
      WHERE dm_queue.status = 'sent'
        AND dm_queue.sent_at >= params.today_start
        AND dm_queue.sent_at < params.today_end
    )::BIGINT AS sent_today,
    COUNT(*) FILTER (WHERE dm_queue.status = 'pending')::BIGINT AS queued
  FROM public.dm_queue AS dm_queue
  CROSS JOIN params
),
deal_windows AS (
  SELECT
    weeks.week_number,
    params.as_of - ((13 - weeks.week_number) * INTERVAL '7 days') AS week_start,
    params.as_of - ((12 - weeks.week_number) * INTERVAL '7 days') AS week_end
  FROM params
  CROSS JOIN pg_catalog.generate_series(1, 12) AS weeks(week_number)
),
deal_summary AS (
  SELECT COUNT(*)::BIGINT AS rolling_30_day_count
  FROM public.deals AS deals
  CROSS JOIN params
  WHERE deals.closed_at >= params.as_of - INTERVAL '30 days'
),
weekly_revenue AS (
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'week', 'W' || deal_windows.week_number::TEXT,
        'revenue', COALESCE(revenue.revenue, 0)
      ) ORDER BY deal_windows.week_number
    ),
    '[]'::JSONB
  ) AS rows
  FROM deal_windows
  LEFT JOIN LATERAL (
    SELECT SUM(deals.deal_value) AS revenue
    FROM public.deals AS deals
    WHERE deals.closed_at >= deal_windows.week_start
      AND deals.closed_at < deal_windows.week_end
  ) AS revenue ON TRUE
),
recent_activity AS (
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', bounded_activity.id,
        'event_type', bounded_activity.event_type,
        'description', bounded_activity.description,
        'created_at', bounded_activity.created_at
      ) ORDER BY bounded_activity.created_at DESC
    ),
    '[]'::JSONB
  ) AS rows
  FROM (
    SELECT activity_log.id, activity_log.event_type, activity_log.description, activity_log.created_at
    FROM public.activity_log AS activity_log
    ORDER BY activity_log.created_at DESC
    LIMIT 20
  ) AS bounded_activity
),
hot_lead_selection AS MATERIALIZED (
  SELECT leads.id, leads.business_name, leads.city, leads.status, leads.created_at
  FROM public.leads AS leads
  WHERE leads.status IN ('replied', 'negotiating', 'interested')
  ORDER BY leads.created_at DESC
  LIMIT 10
),
hot_lead_emails AS (
  SELECT
    hot_lead_selection.id AS lead_id,
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'type', emails.type,
          'sent_at', emails.sent_at,
          'replied_at', emails.replied_at,
          'subject', emails.subject
        ) ORDER BY emails.created_at, emails.id
      ) FILTER (WHERE emails.id IS NOT NULL),
      '[]'::JSONB
    ) AS emails
  FROM hot_lead_selection
  LEFT JOIN public.emails AS emails ON emails.lead_id = hot_lead_selection.id
  GROUP BY hot_lead_selection.id
),
hot_leads AS (
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', hot_lead_selection.id,
        'business_name', hot_lead_selection.business_name,
        'city', hot_lead_selection.city,
        'status', hot_lead_selection.status,
        'emails', hot_lead_emails.emails
      ) ORDER BY
        CASE hot_lead_selection.status
          WHEN 'replied' THEN 1
          WHEN 'negotiating' THEN 2
          WHEN 'interested' THEN 3
          ELSE 4
        END,
        hot_lead_selection.created_at DESC
    ),
    '[]'::JSONB
  ) AS rows
  FROM hot_lead_selection
  JOIN hot_lead_emails ON hot_lead_emails.lead_id = hot_lead_selection.id
)
SELECT pg_catalog.jsonb_build_object(
  'as_of', params.as_of,
  'today_range', pg_catalog.jsonb_build_object(
    'timezone', 'Australia/Sydney',
    'start', params.today_start,
    'end', params.today_end,
    'date_key', params.sydney_date::TEXT
  ),
  'status_counts', status_summary.counts,
  'today_email_stats', pg_catalog.jsonb_build_object(
    'total_sent', email_metrics.sent_today,
    'initial_sent', email_metrics.initial_sent_today,
    'followups_sent', email_metrics.follow_up_1_sent_today + email_metrics.follow_up_2_sent_today + email_metrics.follow_up_3_sent_today,
    'follow_up_1_sent', email_metrics.follow_up_1_sent_today,
    'follow_up_2_sent', email_metrics.follow_up_2_sent_today,
    'follow_up_3_sent', email_metrics.follow_up_3_sent_today
  ),
  'today_dm_stats', pg_catalog.jsonb_build_object('sent_today', dm_summary.sent_today),
  'reply_stats', pg_catalog.jsonb_build_object(
    'total_contacted_leads', status_summary.total_contacted,
    'positive_response_leads', status_summary.positive_replies,
    'replies_today', email_metrics.replies_today,
    'reply_rate', CASE
      WHEN status_summary.total_contacted > 0
        THEN pg_catalog.round((status_summary.positive_replies::NUMERIC / status_summary.total_contacted::NUMERIC) * 100)::INTEGER
      ELSE 0
    END
  ),
  'followup_stats', pg_catalog.jsonb_build_object(
    'sent_today', email_metrics.follow_up_1_sent_today + email_metrics.follow_up_2_sent_today + email_metrics.follow_up_3_sent_today,
    'total_sent', email_metrics.followups_sent_total,
    'pending', followup_summary.pending_follow_up_1 + followup_summary.pending_follow_up_2 + followup_summary.pending_follow_up_3,
    'follow_up_1_sent_today', email_metrics.follow_up_1_sent_today,
    'follow_up_2_sent_today', email_metrics.follow_up_2_sent_today,
    'follow_up_3_sent_today', email_metrics.follow_up_3_sent_today,
    'pending_follow_up_1', followup_summary.pending_follow_up_1,
    'pending_follow_up_2', followup_summary.pending_follow_up_2,
    'pending_follow_up_3', followup_summary.pending_follow_up_3,
    'fu1_due', followup_summary.follow_up_1_due,
    'fu2_due', followup_summary.follow_up_2_due,
    'fu3_due', followup_summary.follow_up_3_due,
    'fu_due', followup_summary.follow_up_1_due + followup_summary.follow_up_2_due + followup_summary.follow_up_3_due,
    'reactivation_total', followup_summary.reactivation_total,
    'overdue_total', followup_summary.overdue_total
  ),
  'daily_activity', daily_activity.rows,
  'emails_sent_this_week', email_metrics.emails_sent_this_week,
  'dms_queued', dm_summary.queued,
  'deals_rolling_30_days', deal_summary.rolling_30_day_count,
  'weekly_revenue', weekly_revenue.rows,
  'recent_activity', recent_activity.rows,
  'hot_leads', hot_leads.rows
)
FROM params
CROSS JOIN status_summary
CROSS JOIN email_metrics
CROSS JOIN followup_summary
CROSS JOIN daily_activity
CROSS JOIN dm_summary
CROSS JOIN deal_summary
CROSS JOIN weekly_revenue
CROSS JOIN recent_activity
CROSS JOIN hot_leads;
$function$;

REVOKE ALL ON FUNCTION public.get_dashboard_summary(TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_summary(TIMESTAMPTZ) TO authenticated, service_role;
