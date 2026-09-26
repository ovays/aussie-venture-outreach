-- Scope the dashboard aggregation once, then run it as the table owner.
--
-- The previous SECURITY INVOKER function relied on RLS to scope every row in
-- every aggregate. The workspace policies call SECURITY DEFINER membership
-- helpers, so the real migrated dataset paid those lookups repeatedly across
-- leads, emails, deals, DMs, and activity. An explicit, authorized workspace
-- lets PostgreSQL use the workspace-leading indexes and avoids per-row RLS.

DROP FUNCTION public.get_dashboard_summary(timestamp with time zone);

CREATE INDEX IF NOT EXISTS leads_workspace_created_at_idx
  ON public.leads (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS emails_workspace_status_sent_at_idx
  ON public.emails (workspace_id, status, sent_at DESC)
  WHERE sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_workspace_closed_at_idx
  ON public.deals (workspace_id, closed_at DESC);
CREATE INDEX IF NOT EXISTS activity_log_workspace_created_at_idx
  ON public.activity_log (workspace_id, created_at DESC);

CREATE FUNCTION public.get_dashboard_summary(
  p_as_of timestamp with time zone DEFAULT now(),
  p_workspace_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_workspace_id uuid := p_workspace_id;
  v_request_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  );
  v_user_id uuid := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
  v_result jsonb;
BEGIN
  -- Compatibility for callers that omit the new argument: resolve the same
  -- first active membership used by the application workspace context.
  IF v_workspace_id IS NULL AND v_user_id IS NOT NULL THEN
    SELECT members.workspace_id
    INTO v_workspace_id
    FROM public.workspace_members AS members
    WHERE members.user_id = v_user_id
      AND members.status = 'active'
    ORDER BY members.created_at, members.workspace_id
    LIMIT 1;
  END IF;

  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace_id required' USING ERRCODE = '22023';
  END IF;

  IF v_request_role IS DISTINCT FROM 'service_role'
     AND NOT public.is_workspace_member(v_workspace_id)
     AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'workspace access denied' USING ERRCODE = '42501';
  END IF;

  WITH
  params AS (
    SELECT
      p_as_of AS as_of,
      (p_as_of AT TIME ZONE 'Australia/Sydney')::date AS sydney_date,
      ((p_as_of AT TIME ZONE 'Australia/Sydney')::date::timestamp AT TIME ZONE 'Australia/Sydney') AS today_start,
      ((((p_as_of AT TIME ZONE 'Australia/Sydney')::date + 1)::timestamp) AT TIME ZONE 'Australia/Sydney') AS today_end
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
      'follow_up_1_days', 'follow_up_2_days', 'follow_up_3_days',
      'reactivation_delay_days', 'dead_after_reactivation_days', 'reactivation_enabled'
    )
  ),
  settings_values AS (
    SELECT
      COALESCE((SUBSTRING(settings_raw.follow_up_1_days FROM '^[+-]?[0-9]+'))::integer, 7) AS follow_up_1_days,
      COALESCE((SUBSTRING(settings_raw.follow_up_2_days FROM '^[+-]?[0-9]+'))::integer, 14) AS follow_up_2_days,
      COALESCE((SUBSTRING(settings_raw.follow_up_3_days FROM '^[+-]?[0-9]+'))::integer, 21) AS follow_up_3_days,
      COALESCE((SUBSTRING(settings_raw.reactivation_delay_days FROM '^[+-]?[0-9]+'))::integer, 60) AS reactivation_delay_days,
      COALESCE((SUBSTRING(settings_raw.dead_after_reactivation_days FROM '^[+-]?[0-9]+'))::integer, 14) AS dead_after_reactivation_days,
      COALESCE(settings_raw.reactivation_enabled = 'true', false) AS reactivation_enabled
    FROM settings_raw
  ),
  status_grouped AS (
    SELECT leads.status::text AS status, COUNT(*)::bigint AS count
    FROM public.leads AS leads
    WHERE leads.workspace_id = v_workspace_id
    GROUP BY leads.status
  ),
  status_summary AS (
    SELECT
      COALESCE(pg_catalog.jsonb_object_agg(status_grouped.status, status_grouped.count)
        FILTER (WHERE status_grouped.status IS NOT NULL), '{}'::jsonb) AS counts,
      COALESCE(SUM(status_grouped.count), 0)::bigint AS all_leads,
      COALESCE(SUM(status_grouped.count) FILTER (
        WHERE status_grouped.status IN ('contacted', 'replied', 'negotiating', 'interested', 'closed', 'closed_manual', 'dead')
      ), 0)::bigint AS total_contacted,
      COALESCE(SUM(status_grouped.count) FILTER (
        WHERE status_grouped.status IN ('replied', 'negotiating', 'interested', 'closed', 'closed_manual')
      ), 0)::bigint AS positive_replies
    FROM status_grouped
  ),
  email_metrics AS (
    SELECT
      COUNT(*) FILTER (WHERE emails.status = 'sent' AND emails.sent_at >= params.today_start AND emails.sent_at < params.today_end)::bigint AS sent_today,
      COUNT(*) FILTER (WHERE emails.status = 'sent' AND emails.type = 'initial_pitch' AND emails.sent_at >= params.today_start AND emails.sent_at < params.today_end)::bigint AS initial_sent_today,
      COUNT(*) FILTER (WHERE emails.status = 'sent' AND emails.type = 'follow_up_1' AND emails.sent_at >= params.today_start AND emails.sent_at < params.today_end)::bigint AS follow_up_1_sent_today,
      COUNT(*) FILTER (WHERE emails.status = 'sent' AND emails.type = 'follow_up_2' AND emails.sent_at >= params.today_start AND emails.sent_at < params.today_end)::bigint AS follow_up_2_sent_today,
      COUNT(*) FILTER (WHERE emails.status = 'sent' AND emails.type = 'follow_up_3' AND emails.sent_at >= params.today_start AND emails.sent_at < params.today_end)::bigint AS follow_up_3_sent_today,
      COUNT(*) FILTER (WHERE emails.status = 'sent' AND emails.type IN ('follow_up_1', 'follow_up_2', 'follow_up_3'))::bigint AS followups_sent_total,
      COUNT(*) FILTER (WHERE emails.replied_at IS NOT NULL AND emails.replied_at >= params.today_start AND emails.replied_at < params.today_end)::bigint AS replies_today,
      COUNT(*) FILTER (WHERE emails.status = 'sent'
        AND emails.sent_at >= (((params.sydney_date - 6)::timestamp) AT TIME ZONE 'Australia/Sydney')
        AND emails.sent_at < params.today_end)::bigint AS emails_sent_this_week
    FROM public.emails AS emails
    CROSS JOIN params
    WHERE emails.workspace_id = v_workspace_id
  ),
  contacted_email_events AS MATERIALIZED (
    SELECT
      leads.id AS lead_id,
      (ARRAY_AGG(emails.sent_at ORDER BY emails.created_at, emails.id)
        FILTER (WHERE emails.type = 'initial_pitch' AND emails.sent_at IS NOT NULL))[1] AS initial_sent_at,
      COALESCE(BOOL_OR(emails.sent_at IS NOT NULL) FILTER (WHERE emails.type = 'follow_up_1'), false) AS follow_up_1_sent,
      COALESCE(BOOL_OR(emails.sent_at IS NOT NULL) FILTER (WHERE emails.type = 'follow_up_2'), false) AS follow_up_2_sent,
      COALESCE(BOOL_OR(emails.sent_at IS NOT NULL) FILTER (WHERE emails.type = 'follow_up_3'), false) AS follow_up_3_sent
    FROM public.leads AS leads
    LEFT JOIN public.emails AS emails
      ON emails.workspace_id = v_workspace_id
     AND emails.lead_id = leads.id
    WHERE leads.workspace_id = v_workspace_id
      AND leads.status = 'contacted'
      AND leads.email IS NOT NULL
      AND leads.email <> ''
    GROUP BY leads.id
  ),
  contacted_eligibility AS (
    SELECT
      leads.id AS lead_id,
      leads.reactivation_sent_at,
      events.initial_sent_at,
      events.follow_up_1_sent,
      events.follow_up_2_sent,
      events.follow_up_3_sent,
      FLOOR(EXTRACT(EPOCH FROM (params.as_of - events.initial_sent_at)) / 86400)::integer AS days_since_initial,
      CASE WHEN leads.reactivation_sent_at IS NULL THEN NULL
        ELSE FLOOR(EXTRACT(EPOCH FROM (params.as_of - leads.reactivation_sent_at)) / 86400)::integer END AS days_since_reactivation,
      CASE
        WHEN NOT events.follow_up_1_sent THEN 'follow_up_1'
        WHEN NOT events.follow_up_2_sent THEN 'follow_up_2'
        WHEN NOT events.follow_up_3_sent THEN 'follow_up_3'
        ELSE NULL
      END AS next_follow_up
    FROM contacted_email_events AS events
    JOIN public.leads AS leads
      ON leads.workspace_id = v_workspace_id
     AND leads.id = events.lead_id
    CROSS JOIN params
    WHERE events.initial_sent_at IS NOT NULL
  ),
  followup_summary AS (
    SELECT
      COUNT(*) FILTER (WHERE eligibility.next_follow_up = 'follow_up_1' AND eligibility.days_since_initial >= settings.follow_up_1_days)::bigint AS pending_follow_up_1,
      COUNT(*) FILTER (WHERE eligibility.next_follow_up = 'follow_up_2' AND eligibility.days_since_initial >= settings.follow_up_2_days)::bigint AS pending_follow_up_2,
      COUNT(*) FILTER (WHERE eligibility.next_follow_up = 'follow_up_3' AND eligibility.days_since_initial >= settings.follow_up_3_days)::bigint AS pending_follow_up_3,
      COUNT(*) FILTER (WHERE eligibility.reactivation_sent_at IS NULL AND eligibility.next_follow_up = 'follow_up_1' AND eligibility.days_since_initial >= settings.follow_up_1_days)::bigint AS follow_up_1_due,
      COUNT(*) FILTER (WHERE eligibility.reactivation_sent_at IS NULL AND eligibility.next_follow_up = 'follow_up_2' AND eligibility.days_since_initial >= settings.follow_up_2_days)::bigint AS follow_up_2_due,
      COUNT(*) FILTER (WHERE eligibility.reactivation_sent_at IS NULL AND eligibility.next_follow_up = 'follow_up_3' AND eligibility.days_since_initial >= settings.follow_up_3_days)::bigint AS follow_up_3_due,
      COUNT(*) FILTER (
        WHERE eligibility.reactivation_sent_at IS NULL AND eligibility.next_follow_up IS NULL AND settings.reactivation_enabled
           OR eligibility.reactivation_sent_at IS NOT NULL AND eligibility.days_since_reactivation < settings.dead_after_reactivation_days
      )::bigint AS reactivation_total,
      COUNT(*) FILTER (
        WHERE eligibility.reactivation_sent_at IS NOT NULL AND eligibility.days_since_reactivation >= settings.dead_after_reactivation_days
           OR eligibility.reactivation_sent_at IS NULL AND eligibility.next_follow_up = 'follow_up_3' AND eligibility.days_since_initial >= settings.follow_up_3_days
           OR eligibility.reactivation_sent_at IS NULL AND eligibility.next_follow_up = 'follow_up_2' AND eligibility.days_since_initial >= settings.follow_up_2_days
           OR eligibility.reactivation_sent_at IS NULL AND eligibility.next_follow_up = 'follow_up_1' AND eligibility.days_since_initial >= settings.follow_up_1_days
           OR eligibility.reactivation_sent_at IS NULL AND eligibility.next_follow_up IS NULL AND settings.reactivation_enabled AND eligibility.days_since_initial >= settings.reactivation_delay_days
           OR eligibility.reactivation_sent_at IS NULL AND eligibility.next_follow_up IS NULL AND NOT settings.reactivation_enabled AND eligibility.days_since_initial >= settings.follow_up_3_days
      )::bigint AS overdue_total
    FROM contacted_eligibility AS eligibility
    CROSS JOIN settings_values AS settings
  ),
  daily_days AS (
    SELECT
      offsets.days_back,
      (params.sydney_date - offsets.days_back)::date AS activity_date
    FROM params
    CROSS JOIN pg_catalog.generate_series(0, 6) AS offsets(days_back)
  ),
  daily_leads AS (
    SELECT (leads.created_at AT TIME ZONE 'Australia/Sydney')::date AS activity_date, COUNT(*)::bigint AS count
    FROM public.leads AS leads
    CROSS JOIN params
    WHERE leads.workspace_id = v_workspace_id
      AND leads.created_at >= (((params.sydney_date - 6)::date::timestamp) AT TIME ZONE 'Australia/Sydney')
      AND leads.created_at < params.today_end
    GROUP BY (leads.created_at AT TIME ZONE 'Australia/Sydney')::date
  ),
  daily_emails AS (
    SELECT
      (emails.sent_at AT TIME ZONE 'Australia/Sydney')::date AS activity_date,
      COUNT(*)::bigint AS emails_sent,
      COUNT(*) FILTER (WHERE emails.type IN ('follow_up_1', 'follow_up_2', 'follow_up_3'))::bigint AS followups_sent
    FROM public.emails AS emails
    CROSS JOIN params
    WHERE emails.workspace_id = v_workspace_id
      AND emails.status = 'sent'
      AND emails.sent_at >= (((params.sydney_date - 6)::date::timestamp) AT TIME ZONE 'Australia/Sydney')
      AND emails.sent_at < params.today_end
    GROUP BY (emails.sent_at AT TIME ZONE 'Australia/Sydney')::date
  ),
  daily_dms AS (
    SELECT (dm_queue.created_at AT TIME ZONE 'Australia/Sydney')::date AS activity_date, COUNT(*)::bigint AS count
    FROM public.dm_queue AS dm_queue
    CROSS JOIN params
    WHERE dm_queue.workspace_id = v_workspace_id
      AND dm_queue.created_at >= (((params.sydney_date - 6)::date::timestamp) AT TIME ZONE 'Australia/Sydney')
      AND dm_queue.created_at < params.today_end
    GROUP BY (dm_queue.created_at AT TIME ZONE 'Australia/Sydney')::date
  ),
  daily_activity AS (
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'date', days.activity_date::text,
      'label', CASE
        WHEN days.days_back = 0 THEN 'Today (' || pg_catalog.to_char(days.activity_date, 'FMDD Mon') || ')'
        WHEN days.days_back = 1 THEN 'Yesterday (' || pg_catalog.to_char(days.activity_date, 'FMDD Mon') || ')'
        ELSE pg_catalog.to_char(days.activity_date, 'FMDD Mon') END,
      'leads_found', COALESCE(leads.count, 0),
      'emails_sent', COALESCE(emails.emails_sent, 0),
      'dms_queued', COALESCE(dms.count, 0),
      'followups_sent', COALESCE(emails.followups_sent, 0)
    ) ORDER BY days.days_back), '[]'::jsonb) AS rows
    FROM daily_days AS days
    LEFT JOIN daily_leads AS leads ON leads.activity_date = days.activity_date
    LEFT JOIN daily_emails AS emails ON emails.activity_date = days.activity_date
    LEFT JOIN daily_dms AS dms ON dms.activity_date = days.activity_date
  ),
  dm_summary AS (
    SELECT
      COUNT(*) FILTER (WHERE dm_queue.status = 'sent' AND dm_queue.sent_at >= params.today_start AND dm_queue.sent_at < params.today_end)::bigint AS sent_today,
      COUNT(*) FILTER (WHERE dm_queue.status = 'pending')::bigint AS queued
    FROM public.dm_queue AS dm_queue
    CROSS JOIN params
    WHERE dm_queue.workspace_id = v_workspace_id
  ),
  deal_windows AS (
    SELECT weeks.week_number,
      params.as_of - ((13 - weeks.week_number) * interval '7 days') AS week_start,
      params.as_of - ((12 - weeks.week_number) * interval '7 days') AS week_end
    FROM params
    CROSS JOIN pg_catalog.generate_series(1, 12) AS weeks(week_number)
  ),
  deal_summary AS (
    SELECT COUNT(*)::bigint AS rolling_30_day_count
    FROM public.deals AS deals
    CROSS JOIN params
    WHERE deals.workspace_id = v_workspace_id
      AND deals.closed_at >= params.as_of - interval '30 days'
  ),
  weekly_revenue AS (
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'week', 'W' || windows.week_number::text,
      'revenue', COALESCE(revenue.revenue, 0)
    ) ORDER BY windows.week_number), '[]'::jsonb) AS rows
    FROM deal_windows AS windows
    LEFT JOIN LATERAL (
      SELECT SUM(deals.deal_value) AS revenue
      FROM public.deals AS deals
      WHERE deals.workspace_id = v_workspace_id
        AND deals.closed_at >= windows.week_start
        AND deals.closed_at < windows.week_end
    ) AS revenue ON true
  ),
  recent_activity AS (
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', bounded.id, 'event_type', bounded.event_type,
      'description', bounded.description, 'created_at', bounded.created_at
    ) ORDER BY bounded.created_at DESC), '[]'::jsonb) AS rows
    FROM (
      SELECT activity.id, activity.event_type, activity.description, activity.created_at
      FROM public.activity_log AS activity
      WHERE activity.workspace_id = v_workspace_id
      ORDER BY activity.created_at DESC
      LIMIT 20
    ) AS bounded
  ),
  hot_lead_selection AS MATERIALIZED (
    SELECT leads.id, leads.business_name, leads.city, leads.status, leads.created_at
    FROM public.leads AS leads
    WHERE leads.workspace_id = v_workspace_id
      AND leads.status IN ('replied', 'negotiating', 'interested')
    ORDER BY leads.created_at DESC
    LIMIT 10
  ),
  hot_lead_emails AS (
    SELECT selected.id AS lead_id,
      COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'type', emails.type, 'sent_at', emails.sent_at,
        'replied_at', emails.replied_at, 'subject', emails.subject
      ) ORDER BY emails.created_at, emails.id) FILTER (WHERE emails.id IS NOT NULL), '[]'::jsonb) AS emails
    FROM hot_lead_selection AS selected
    LEFT JOIN public.emails AS emails
      ON emails.workspace_id = v_workspace_id
     AND emails.lead_id = selected.id
    GROUP BY selected.id
  ),
  hot_leads AS (
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', selected.id, 'business_name', selected.business_name,
      'city', selected.city, 'status', selected.status, 'emails', email_rows.emails
    ) ORDER BY CASE selected.status WHEN 'replied' THEN 1 WHEN 'negotiating' THEN 2 WHEN 'interested' THEN 3 ELSE 4 END,
      selected.created_at DESC), '[]'::jsonb) AS rows
    FROM hot_lead_selection AS selected
    JOIN hot_lead_emails AS email_rows ON email_rows.lead_id = selected.id
  )
  SELECT pg_catalog.jsonb_build_object(
    'as_of', params.as_of,
    'today_range', pg_catalog.jsonb_build_object('timezone', 'Australia/Sydney', 'start', params.today_start, 'end', params.today_end, 'date_key', params.sydney_date::text),
    'status_counts', status_summary.counts,
    'today_email_stats', pg_catalog.jsonb_build_object(
      'total_sent', email_metrics.sent_today, 'initial_sent', email_metrics.initial_sent_today,
      'followups_sent', email_metrics.follow_up_1_sent_today + email_metrics.follow_up_2_sent_today + email_metrics.follow_up_3_sent_today,
      'follow_up_1_sent', email_metrics.follow_up_1_sent_today,
      'follow_up_2_sent', email_metrics.follow_up_2_sent_today,
      'follow_up_3_sent', email_metrics.follow_up_3_sent_today),
    'today_dm_stats', pg_catalog.jsonb_build_object('sent_today', dm_summary.sent_today),
    'reply_stats', pg_catalog.jsonb_build_object(
      'total_contacted_leads', status_summary.total_contacted,
      'positive_response_leads', status_summary.positive_replies,
      'replies_today', email_metrics.replies_today,
      'reply_rate', CASE WHEN status_summary.total_contacted > 0
        THEN pg_catalog.round((status_summary.positive_replies::numeric / status_summary.total_contacted::numeric) * 100)::integer ELSE 0 END),
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
      'overdue_total', followup_summary.overdue_total),
    'daily_activity', daily_activity.rows,
    'emails_sent_this_week', email_metrics.emails_sent_this_week,
    'dms_queued', dm_summary.queued,
    'deals_rolling_30_days', deal_summary.rolling_30_day_count,
    'weekly_revenue', weekly_revenue.rows,
    'recent_activity', recent_activity.rows,
    'hot_leads', hot_leads.rows
  )
  INTO v_result
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

  RETURN v_result;
END
$$;

ALTER FUNCTION public.get_dashboard_summary(timestamp with time zone, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_dashboard_summary(timestamp with time zone, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_summary(timestamp with time zone, uuid) TO authenticated, service_role;
