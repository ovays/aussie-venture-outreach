-- SaaS 9A: bounded, workspace-scoped list reads and supporting indexes.
-- This migration intentionally leaves get_dashboard_summary unchanged.

-- Existing SECURITY DEFINER functions are owned by this NOLOGIN role. The
-- deployment login receives temporary inheritable membership, and the owner
-- receives temporary CREATE only so new function ownership can be assigned.
GRANT reachagent_function_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
GRANT CREATE ON SCHEMA public TO reachagent_function_owner;

-- Stable list ordering needs the row id in the btree. Replace the shorter
-- indexes rather than retaining overlapping write overhead.
DROP INDEX IF EXISTS public.leads_workspace_created_at_idx;
CREATE INDEX leads_workspace_created_at_idx
  ON public.leads (workspace_id, created_at DESC, id ASC);

DROP INDEX IF EXISTS public.leads_workspace_status_created_at_idx;
CREATE INDEX leads_workspace_status_created_at_idx
  ON public.leads (workspace_id, status, created_at DESC, id ASC);

DROP INDEX IF EXISTS public.leads_workspace_city_status_created_at_idx;
CREATE INDEX leads_workspace_city_status_created_at_idx
  ON public.leads (workspace_id, city, status, created_at DESC, id ASC);

DROP INDEX IF EXISTS public.leads_workspace_category_status_created_at_idx;
CREATE INDEX leads_workspace_category_status_created_at_idx
  ON public.leads (workspace_id, category_name, status, created_at DESC, id ASC);

CREATE INDEX emails_workspace_created_at_id_idx
  ON public.emails (workspace_id, created_at DESC, id ASC);
CREATE INDEX emails_workspace_type_created_at_id_idx
  ON public.emails (workspace_id, type, created_at DESC, id ASC);

DROP INDEX IF EXISTS public.deals_workspace_closed_at_idx;
CREATE INDEX deals_workspace_closed_at_idx
  ON public.deals (workspace_id, closed_at DESC, id ASC);

DROP INDEX IF EXISTS public.dm_queue_workspace_status_created_at_idx;
CREATE INDEX dm_queue_workspace_status_created_at_idx
  ON public.dm_queue (workspace_id, status, created_at DESC, id ASC);
CREATE INDEX dm_queue_workspace_platform_created_at_idx
  ON public.dm_queue (workspace_id, platform, created_at DESC, id ASC);

CREATE INDEX activity_log_workspace_delivery_email_created_at_idx
  ON public.activity_log (workspace_id, ((metadata ->> 'email_id')), created_at DESC, id DESC)
  WHERE event_type = 'delivery_terminal_failure';

-- Leads: explicit workspace predicate, narrow materialized projection, stable
-- ordering, server-side filters, and a hard maximum page size.
CREATE FUNCTION public.get_leads_search_page(
  p_workspace_id uuid,
  p_statuses text[] DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_search text DEFAULT '',
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 50,
  p_ids_only boolean DEFAULT false
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog'
AS $$
WITH validated AS (
  SELECT pg_catalog.btrim(COALESCE(p_search, '')) AS search_term,
    GREATEST(COALESCE(p_page, 1), 1) AS page_number,
    LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 1000) AS page_size
), matched AS MATERIALIZED (
  SELECT leads.id, leads.business_name, leads.category_name, leads.city,
    leads.suburb, leads.email, leads.instagram_handle, leads.google_rating,
    leads.halal_confidence_score, leads.status, leads.created_at, leads.halal,
    leads.delivery_suppressed_emails, leads.outreach_suppression_reason,
    leads.outreach_suppressed_at
  FROM public.leads AS leads CROSS JOIN validated
  WHERE leads.workspace_id = p_workspace_id
    AND (
      p_statuses IS NULL
      OR ('suppressed' = ANY (p_statuses) AND (
        leads.outreach_suppressed_at IS NOT NULL
        OR leads.outreach_suppression_reason IS NOT NULL
        OR COALESCE(NULLIF(pg_catalog.lower(pg_catalog.btrim(leads.email)), '') = ANY (leads.delivery_suppressed_emails), false)
      ))
      OR (leads.status = ANY (p_statuses) AND NOT (
        p_statuses = ARRAY['researched']::text[] AND (
          leads.outreach_suppressed_at IS NOT NULL
          OR leads.outreach_suppression_reason IS NOT NULL
          OR COALESCE(NULLIF(pg_catalog.lower(pg_catalog.btrim(leads.email)), '') = ANY (leads.delivery_suppressed_emails), false)
        )
      ))
    )
    AND (p_category IS NULL OR leads.category_name = p_category)
    AND (p_city IS NULL OR leads.city = p_city)
    AND (validated.search_term = ''
      OR leads.business_name ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
      OR COALESCE(leads.email, '') ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\')
), paged AS (
  SELECT matched.* FROM matched CROSS JOIN validated
  ORDER BY matched.created_at DESC, matched.id ASC
  OFFSET ((SELECT page_number - 1 FROM validated) * (SELECT page_size FROM validated))
  LIMIT (SELECT page_size FROM validated)
), rows AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(
    CASE WHEN p_ids_only THEN pg_catalog.jsonb_build_object('id', paged.id)
    ELSE pg_catalog.jsonb_build_object(
      'id', paged.id, 'business_name', paged.business_name,
      'category_name', paged.category_name, 'city', paged.city,
      'suburb', paged.suburb, 'email', paged.email,
      'instagram_handle', paged.instagram_handle,
      'google_rating', paged.google_rating,
      'halal_confidence_score', paged.halal_confidence_score,
      'status', paged.status, 'created_at', paged.created_at,
      'halal', paged.halal,
      'delivery_suppressed_emails', paged.delivery_suppressed_emails,
      'outreach_suppression_reason', paged.outreach_suppression_reason,
      'outreach_suppressed_at', paged.outreach_suppressed_at)
    END ORDER BY paged.created_at DESC, paged.id ASC), '[]'::jsonb) AS data
  FROM paged
)
SELECT pg_catalog.jsonb_build_object('data', rows.data, 'total', (SELECT COUNT(*) FROM matched))
FROM rows;
$$;

-- Pipeline: do not carry lead notes, research payloads, or other detail-only
-- columns through the materialized match set.
CREATE FUNCTION public.get_pipeline_search_page(
  p_workspace_id uuid,
  p_statuses text[],
  p_search text DEFAULT '',
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 50
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog'
AS $$
WITH validated AS (
  SELECT pg_catalog.btrim(COALESCE(p_search, '')) AS search_term,
    GREATEST(COALESCE(p_page, 1), 1) AS page_number,
    LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 100) AS page_size
), matched AS MATERIALIZED (
  SELECT leads.id, leads.business_name, leads.category_name, leads.city,
    leads.suburb, leads.status, leads.deal_value, leads.created_at
  FROM public.leads AS leads CROSS JOIN validated
  WHERE leads.workspace_id = p_workspace_id
    AND leads.status = ANY (COALESCE(p_statuses, ARRAY[]::text[]))
    AND (validated.search_term = ''
      OR leads.business_name ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
      OR COALESCE(leads.email, '') ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\')
), paged AS (
  SELECT matched.* FROM matched CROSS JOIN validated
  ORDER BY matched.created_at DESC, matched.id ASC
  OFFSET ((SELECT page_number - 1 FROM validated) * (SELECT page_size FROM validated))
  LIMIT (SELECT page_size FROM validated)
), rows AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(paged)
    ORDER BY paged.created_at DESC, paged.id ASC), '[]'::jsonb) AS data
  FROM paged
)
SELECT pg_catalog.jsonb_build_object('data', rows.data, 'total', (SELECT COUNT(*) FROM matched))
FROM rows;
$$;

CREATE FUNCTION public.get_deals_search_page(
  p_workspace_id uuid,
  p_search text DEFAULT '',
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 50
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog'
AS $$
WITH validated AS (
  SELECT pg_catalog.btrim(COALESCE(p_search, '')) AS search_term,
    GREATEST(COALESCE(p_page, 1), 1) AS page_number,
    LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 100) AS page_size
), joined AS MATERIALIZED (
  SELECT deals.id, deals.lead_id, deals.deal_value, deals.deal_type,
    deals.content_created, deals.payment_received, deals.notes, deals.closed_at,
    leads.business_name, leads.category_name, leads.city, leads.suburb, leads.email
  FROM public.deals AS deals
  LEFT JOIN public.leads AS leads
    ON leads.workspace_id = p_workspace_id AND leads.id = deals.lead_id
  WHERE deals.workspace_id = p_workspace_id
), matched AS MATERIALIZED (
  SELECT joined.* FROM joined CROSS JOIN validated
  WHERE validated.search_term = ''
    OR COALESCE(joined.business_name, '') ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
    OR COALESCE(joined.email, '') ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
), paged AS (
  SELECT matched.* FROM matched CROSS JOIN validated
  ORDER BY matched.closed_at DESC, matched.id ASC
  OFFSET ((SELECT page_number - 1 FROM validated) * (SELECT page_size FROM validated))
  LIMIT (SELECT page_size FROM validated)
), rows AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', paged.id, 'deal_value', paged.deal_value, 'deal_type', paged.deal_type,
    'content_created', paged.content_created, 'payment_received', paged.payment_received,
    'notes', paged.notes, 'closed_at', paged.closed_at,
    'leads', CASE WHEN paged.lead_id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
      'business_name', paged.business_name, 'category_name', paged.category_name,
      'city', paged.city, 'suburb', paged.suburb, 'email', paged.email) END
  ) ORDER BY paged.closed_at DESC, paged.id ASC), '[]'::jsonb) AS data FROM paged
), summary AS (
  SELECT COALESCE(SUM(joined.deal_value), 0) AS total_revenue,
    COALESCE(SUM(joined.deal_value) FILTER (WHERE joined.closed_at >= now() - INTERVAL '30 days'), 0) AS month_revenue,
    COALESCE(SUM(joined.deal_value) FILTER (WHERE joined.closed_at >= now() - INTERVAL '7 days'), 0) AS week_revenue,
    COALESCE(AVG(joined.deal_value), 0) AS average_value,
    COUNT(*) AS total_deals
  FROM joined
)
SELECT pg_catalog.jsonb_build_object(
  'data', rows.data, 'total', (SELECT COUNT(*) FROM matched),
  'summary', pg_catalog.to_jsonb(summary))
FROM rows CROSS JOIN summary;
$$;

CREATE FUNCTION public.get_dm_queue_search_page(
  p_workspace_id uuid,
  p_status text DEFAULT NULL,
  p_platform text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_search text DEFAULT '',
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 50
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog'
AS $$
WITH validated AS (
  SELECT pg_catalog.btrim(COALESCE(p_search, '')) AS search_term,
    GREATEST(COALESCE(p_page, 1), 1) AS page_number,
    LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 100) AS page_size
), matched AS MATERIALIZED (
  SELECT dm.id, dm.lead_id, dm.platform, dm.handle, dm.message_text,
    dm.status, dm.created_at, leads.business_name, leads.category_name, leads.city
  FROM public.dm_queue AS dm
  LEFT JOIN public.leads AS leads
    ON leads.workspace_id = p_workspace_id AND leads.id = dm.lead_id
  CROSS JOIN validated
  WHERE dm.workspace_id = p_workspace_id
    AND (p_status IS NULL OR dm.status = p_status)
    AND (p_platform IS NULL OR dm.platform = p_platform)
    AND (p_city IS NULL OR leads.city = p_city)
    AND (validated.search_term = ''
      OR COALESCE(leads.business_name, '') ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
      OR dm.handle ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\')
), paged AS (
  SELECT matched.* FROM matched CROSS JOIN validated
  ORDER BY matched.created_at DESC, matched.id ASC
  OFFSET ((SELECT page_number - 1 FROM validated) * (SELECT page_size FROM validated))
  LIMIT (SELECT page_size FROM validated)
), rows AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', paged.id, 'platform', paged.platform, 'handle', paged.handle,
    'message_text', paged.message_text, 'status', paged.status,
    'created_at', paged.created_at,
    'leads', CASE WHEN paged.lead_id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
      'business_name', paged.business_name, 'category_name', paged.category_name, 'city', paged.city) END
  ) ORDER BY paged.created_at DESC, paged.id ASC), '[]'::jsonb) AS data FROM paged
)
SELECT pg_catalog.jsonb_build_object('data', rows.data, 'total', (SELECT COUNT(*) FROM matched))
FROM rows;
$$;

-- Email Log now returns the list, total, and summary from one database call.
CREATE FUNCTION public.get_email_log_search_page(
  p_workspace_id uuid,
  p_type text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_search text DEFAULT '',
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 50
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog'
AS $$
WITH validated AS (
  SELECT pg_catalog.btrim(COALESCE(p_search, '')) AS search_term,
    GREATEST(COALESCE(p_page, 1), 1) AS page_number,
    LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 100) AS page_size
), lead_counts AS (
  SELECT
    COUNT(*) FILTER (WHERE leads.status IN ('contacted','replied','negotiating','interested','closed','closed_manual','dead'))::bigint AS contacted,
    COUNT(*) FILTER (WHERE leads.status IN ('replied','negotiating','interested','closed','closed_manual'))::bigint AS positive
  FROM public.leads AS leads WHERE leads.workspace_id = p_workspace_id
), matched AS MATERIALIZED (
  SELECT emails.id, emails.lead_id, emails.type, emails.subject, emails.status,
    emails.sent_at, emails.replied_at, emails.created_at,
    leads.business_name, leads.category_name, leads.city, leads.email AS recipient_email
  FROM public.emails AS emails
  LEFT JOIN public.leads AS leads
    ON leads.workspace_id = p_workspace_id AND leads.id = emails.lead_id
  CROSS JOIN validated
  WHERE emails.workspace_id = p_workspace_id
    AND (p_type IS NULL OR emails.type = p_type)
    AND (p_status IS NULL OR emails.status = p_status)
    AND (validated.search_term = ''
      OR emails.subject ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
      OR COALESCE(leads.business_name, '') ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
      OR COALESCE(leads.email, '') ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\')
), paged AS (
  SELECT matched.* FROM matched CROSS JOIN validated
  ORDER BY matched.created_at DESC, matched.id ASC
  OFFSET ((SELECT page_number - 1 FROM validated) * (SELECT page_size FROM validated))
  LIMIT (SELECT page_size FROM validated)
), rows AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', paged.id, 'type', paged.type, 'subject', paged.subject,
    'status', paged.status, 'sent_at', paged.sent_at,
    'replied_at', paged.replied_at, 'created_at', paged.created_at,
    'leads', CASE WHEN paged.lead_id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
      'business_name', paged.business_name, 'category_name', paged.category_name,
      'city', paged.city, 'email', paged.recipient_email) END
  ) ORDER BY paged.created_at DESC, paged.id ASC), '[]'::jsonb) AS data FROM paged
), recent_bounces AS (
  SELECT COUNT(*) FILTER (WHERE bounded.status = 'bounced')::bigint AS bounced
  FROM (
    SELECT matched.status FROM matched
    ORDER BY matched.created_at DESC, matched.id ASC LIMIT 500
  ) AS bounded
)
SELECT pg_catalog.jsonb_build_object(
  'data', rows.data,
  'total', (SELECT COUNT(*) FROM matched),
  'summary', pg_catalog.jsonb_build_object(
    'total_contacted_leads', lead_counts.contacted,
    'positive_response_leads', lead_counts.positive,
    'reply_rate', CASE WHEN lead_counts.contacted > 0
      THEN pg_catalog.round(lead_counts.positive::numeric / lead_counts.contacted::numeric * 100)::integer ELSE 0 END,
    'matching_bounced', recent_bounces.bounced))
FROM rows CROSS JOIN lead_counts CROSS JOIN recent_bounces;
$$;

-- The lifecycle calculation is intentionally preserved byte-for-byte apart
-- from explicit workspace predicates. Guarded replacements make drift fail
-- the migration rather than silently changing lifecycle meaning.
DO $migration$
DECLARE
  v_definition text;
  v_changed text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.get_lifecycle_page(timestamptz,text,text,text,text,integer,integer)'::regprocedure
  ) INTO v_definition;

  v_changed := pg_catalog.replace(v_definition,
    'FUNCTION public.get_lifecycle_page(',
    'FUNCTION public.get_lifecycle_page(p_workspace_id uuid, ');
  IF v_changed = v_definition THEN RAISE EXCEPTION 'lifecycle signature drift'; END IF;
  v_definition := v_changed;

  v_changed := pg_catalog.replace(v_definition,
    '  WHERE leads.status = ''dead''',
    '  WHERE leads.workspace_id = p_workspace_id AND leads.status = ''dead''');
  IF v_changed = v_definition THEN RAISE EXCEPTION 'lifecycle dead candidate drift'; END IF;
  v_definition := v_changed;

  v_changed := pg_catalog.replace(v_definition,
    '  WHERE leads.status = ''contacted''',
    '  WHERE leads.workspace_id = p_workspace_id AND leads.status = ''contacted''');
  IF v_changed = v_definition THEN RAISE EXCEPTION 'lifecycle contacted candidate drift'; END IF;
  v_definition := v_changed;

  v_changed := pg_catalog.replace(v_definition,
    '  LEFT JOIN public.emails AS emails ON emails.lead_id = leads.id',
    '  LEFT JOIN public.emails AS emails ON emails.workspace_id = p_workspace_id AND emails.lead_id = leads.id');
  IF v_changed = v_definition THEN RAISE EXCEPTION 'lifecycle email join drift'; END IF;
  v_definition := v_changed;

  v_changed := pg_catalog.replace(v_definition,
    '  WHERE event_type = ''lead_marked_dead''',
    '  WHERE workspace_id = p_workspace_id AND event_type = ''lead_marked_dead''');
  IF v_changed = v_definition THEN RAISE EXCEPTION 'lifecycle activity predicate drift'; END IF;

  EXECUTE v_changed;
END
$migration$;

-- Delivery report functions preserve their established terminal-state logic;
-- only server-resolved workspace predicates are added.
DO $migration$
DECLARE
  v_definition text;
  v_changed text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.get_delivery_failure_report(text,text,text,integer,integer)'::regprocedure
  ) INTO v_definition;
  v_changed := pg_catalog.replace(v_definition,
    'FUNCTION public.get_delivery_failure_report(',
    'FUNCTION public.get_delivery_failure_report(p_workspace_id uuid, ');
  IF v_changed = v_definition THEN RAISE EXCEPTION 'delivery report signature drift'; END IF;
  v_definition := v_changed;
  v_changed := pg_catalog.replace(v_definition,
    '  LEFT JOIN public.leads AS leads ON leads.id = emails.lead_id',
    '  LEFT JOIN public.leads AS leads ON leads.workspace_id = p_workspace_id AND leads.id = emails.lead_id');
  IF v_changed = v_definition THEN RAISE EXCEPTION 'delivery report lead join drift'; END IF;
  v_definition := v_changed;
  v_changed := pg_catalog.replace(v_definition,
    '    WHERE activity_log.event_type = ''delivery_terminal_failure''',
    '    WHERE activity_log.workspace_id = p_workspace_id AND activity_log.event_type = ''delivery_terminal_failure''');
  IF v_changed = v_definition THEN RAISE EXCEPTION 'delivery report provider event drift'; END IF;
  v_definition := v_changed;
  v_changed := pg_catalog.replace(v_definition,
    '  WHERE emails.status IN (''bounced'', ''failed'', ''suppressed'')',
    '  WHERE emails.workspace_id = p_workspace_id AND emails.status IN (''bounced'', ''failed'', ''suppressed'')');
  IF v_changed = v_definition THEN RAISE EXCEPTION 'delivery report email predicate drift'; END IF;
  v_definition := v_changed;
  v_changed := pg_catalog.replace(v_definition,
    '  WHERE activity_log.event_type = ''delivery_terminal_failure''',
    '  WHERE activity_log.workspace_id = p_workspace_id AND activity_log.event_type = ''delivery_terminal_failure''');
  IF v_changed = v_definition THEN RAISE EXCEPTION 'delivery report history predicate drift'; END IF;
  v_definition := v_changed;
  v_changed := pg_catalog.replace(v_definition,
    '      WHERE emails.id::TEXT = activity_log.metadata ->> ''email_id''',
    '      WHERE emails.workspace_id = p_workspace_id AND emails.id::TEXT = activity_log.metadata ->> ''email_id''');
  IF v_changed = v_definition THEN RAISE EXCEPTION 'delivery report history anti-join drift'; END IF;
  EXECUTE v_changed;

  SELECT pg_catalog.pg_get_functiondef(
    'public.get_delivery_failure_lead_selection(text,text,text,boolean)'::regprocedure
  ) INTO v_definition;
  v_changed := pg_catalog.replace(v_definition,
    'FUNCTION public.get_delivery_failure_lead_selection(',
    'FUNCTION public.get_delivery_failure_lead_selection(p_workspace_id uuid, ');
  IF v_changed = v_definition THEN RAISE EXCEPTION 'delivery selection signature drift'; END IF;
  v_definition := v_changed;
  v_changed := pg_catalog.replace(v_definition,
    '  JOIN public.leads AS leads ON leads.id = emails.lead_id',
    '  JOIN public.leads AS leads ON leads.workspace_id = p_workspace_id AND leads.id = emails.lead_id');
  IF v_changed = v_definition THEN RAISE EXCEPTION 'delivery selection lead join drift'; END IF;
  v_definition := v_changed;
  v_changed := pg_catalog.replace(v_definition,
    '    WHERE activity_log.event_type = ''delivery_terminal_failure''',
    '    WHERE activity_log.workspace_id = p_workspace_id AND activity_log.event_type = ''delivery_terminal_failure''');
  IF v_changed = v_definition THEN RAISE EXCEPTION 'delivery selection provider event drift'; END IF;
  v_definition := v_changed;
  v_changed := pg_catalog.replace(v_definition,
    '  WHERE emails.status IN (''bounced'', ''failed'', ''suppressed'')',
    '  WHERE emails.workspace_id = p_workspace_id AND emails.status IN (''bounced'', ''failed'', ''suppressed'')');
  IF v_changed = v_definition THEN RAISE EXCEPTION 'delivery selection email predicate drift'; END IF;
  EXECUTE v_changed;
END
$migration$;

-- Replace correlated per-workspace counts with one grouped pass per table.
CREATE OR REPLACE FUNCTION public.admin_list_workspace_directory()
RETURNS TABLE (
  id uuid, name text, slug text, status text, created_at timestamptz,
  member_count bigint, stored_leads bigint, mailbox_count bigint,
  plan_code text, plan_name text, billing_status text
)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  WITH member_counts AS (
    SELECT workspace_id, COUNT(*)::bigint AS count FROM public.workspace_members
    WHERE workspace_members.status = 'active' GROUP BY workspace_id
  ), lead_counts AS (
    SELECT workspace_id, COUNT(*)::bigint AS count FROM public.leads GROUP BY workspace_id
  ), mailbox_counts AS (
    SELECT workspace_id, COUNT(*)::bigint AS count FROM public.mailbox_connections
    WHERE mailbox_connections.status <> 'disconnected' GROUP BY workspace_id
  )
  SELECT w.id, w.name, w.slug, w.status, w.created_at,
    COALESCE(m.count, 0), COALESCE(l.count, 0), COALESCE(mc.count, 0),
    p.plan_code, p.name, b.subscription_status
  FROM public.workspaces w
  LEFT JOIN member_counts m ON m.workspace_id = w.id
  LEFT JOIN lead_counts l ON l.workspace_id = w.id
  LEFT JOIN mailbox_counts mc ON mc.workspace_id = w.id
  LEFT JOIN public.workspace_entitlements e ON e.workspace_id = w.id
  LEFT JOIN public.entitlement_profiles p ON p.id = e.entitlement_profile_id
  LEFT JOIN public.workspace_billing_accounts b ON b.workspace_id = w.id
  ORDER BY w.created_at ASC, w.id ASC;
END
$$;
ALTER FUNCTION public.admin_list_workspace_directory() OWNER TO reachagent_function_owner;

CREATE FUNCTION public.admin_list_workspace_directory_page(
  p_search text DEFAULT '', p_page integer DEFAULT 1, p_page_size integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
  v_page integer := GREATEST(COALESCE(p_page, 1), 1);
  v_page_size integer := LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 100);
  v_search text := pg_catalog.btrim(COALESCE(p_search, ''));
  v_result jsonb;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  WITH matched AS MATERIALIZED (
    SELECT w.id, w.name, w.slug, w.status, w.created_at,
      p.plan_code, p.name AS plan_name, b.subscription_status AS billing_status
    FROM public.workspaces w
    LEFT JOIN public.workspace_entitlements e ON e.workspace_id = w.id
    LEFT JOIN public.entitlement_profiles p ON p.id = e.entitlement_profile_id
    LEFT JOIN public.workspace_billing_accounts b ON b.workspace_id = w.id
    WHERE v_search = ''
      OR w.name ILIKE public.literal_ilike_pattern(v_search) ESCAPE E'\\'
      OR w.slug ILIKE public.literal_ilike_pattern(v_search) ESCAPE E'\\'
  ), paged AS MATERIALIZED (
    SELECT * FROM matched ORDER BY created_at ASC, id ASC
    OFFSET (v_page - 1) * v_page_size LIMIT v_page_size
  ), member_counts AS (
    SELECT m.workspace_id, COUNT(*)::bigint AS count
    FROM public.workspace_members m JOIN paged ON paged.id = m.workspace_id
    WHERE m.status = 'active' GROUP BY m.workspace_id
  ), lead_counts AS (
    SELECT l.workspace_id, COUNT(*)::bigint AS count
    FROM public.leads l JOIN paged ON paged.id = l.workspace_id GROUP BY l.workspace_id
  ), mailbox_counts AS (
    SELECT mc.workspace_id, COUNT(*)::bigint AS count
    FROM public.mailbox_connections mc JOIN paged ON paged.id = mc.workspace_id
    WHERE mc.status <> 'disconnected' GROUP BY mc.workspace_id
  ), rows AS (
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', paged.id, 'name', paged.name, 'slug', paged.slug,
      'status', paged.status, 'created_at', paged.created_at,
      'member_count', COALESCE(member_counts.count, 0),
      'stored_leads', COALESCE(lead_counts.count, 0),
      'mailbox_count', COALESCE(mailbox_counts.count, 0),
      'plan_code', paged.plan_code, 'plan_name', paged.plan_name,
      'billing_status', paged.billing_status)
      ORDER BY paged.created_at ASC, paged.id ASC), '[]'::jsonb) AS data
    FROM paged
    LEFT JOIN member_counts ON member_counts.workspace_id = paged.id
    LEFT JOIN lead_counts ON lead_counts.workspace_id = paged.id
    LEFT JOIN mailbox_counts ON mailbox_counts.workspace_id = paged.id
  )
  SELECT pg_catalog.jsonb_build_object(
    'data', rows.data, 'total', (SELECT COUNT(*) FROM matched),
    'page', v_page, 'page_size', v_page_size)
  INTO v_result FROM rows;
  RETURN v_result;
END
$$;
ALTER FUNCTION public.admin_list_workspace_directory_page(text, integer, integer)
  OWNER TO reachagent_function_owner;

-- Settings usage cards need aggregates, not every raw activity row.
CREATE FUNCTION public.get_settings_performance_summary(
  p_workspace_id uuid, p_as_of timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
  v_result jsonb;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  WITH events AS MATERIALIZED (
    SELECT created_at,
      CASE WHEN pg_catalog.jsonb_typeof(metadata -> 'outscraper_calls') = 'number'
        THEN (metadata ->> 'outscraper_calls')::numeric ELSE 0 END AS calls
    FROM public.activity_log
    WHERE workspace_id = p_workspace_id AND event_type = 'finder_complete'
      AND created_at >= p_as_of - interval '30 days'
  ), totals AS (
    SELECT COUNT(*)::bigint AS total_runs,
      COALESCE(SUM(calls) FILTER (WHERE created_at >= date_trunc('day', p_as_of AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0) AS today_calls,
      COALESCE(SUM(calls) FILTER (WHERE created_at >= p_as_of - interval '7 days'), 0) AS week_calls,
      COALESCE(SUM(calls), 0) AS month_calls
    FROM events
  ), days AS (
    SELECT day::date AS date FROM pg_catalog.generate_series(
      (p_as_of AT TIME ZONE 'UTC')::date - 6,
      (p_as_of AT TIME ZONE 'UTC')::date,
      interval '1 day') AS day
  ), daily AS (
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'date', days.date::text,
      'runs', COALESCE(grouped.runs, 0),
      'calls', COALESCE(grouped.calls, 0)) ORDER BY days.date DESC), '[]'::jsonb) AS rows
    FROM days LEFT JOIN (
      SELECT (created_at AT TIME ZONE 'UTC')::date AS date,
        COUNT(*)::bigint AS runs, COALESCE(SUM(calls), 0) AS calls
      FROM events
      WHERE created_at >= ((p_as_of AT TIME ZONE 'UTC')::date - 6)::timestamp AT TIME ZONE 'UTC'
      GROUP BY (created_at AT TIME ZONE 'UTC')::date
    ) grouped ON grouped.date = days.date
  )
  SELECT pg_catalog.jsonb_build_object(
    'today_calls', totals.today_calls, 'week_calls', totals.week_calls,
    'month_calls', totals.month_calls, 'total_runs', totals.total_runs,
    'last_7_days', daily.rows,
    'dead_letter_count', (SELECT COUNT(*) FROM public.dead_letter_queue
      WHERE workspace_id = p_workspace_id AND resolved = false
        AND created_at >= p_as_of - interval '24 hours'),
    'search_cache_count', (SELECT COUNT(*) FROM public.search_cache
      WHERE workspace_id = p_workspace_id AND expires_at > p_as_of))
  INTO v_result FROM totals CROSS JOIN daily;
  RETURN v_result;
END
$$;
ALTER FUNCTION public.get_settings_performance_summary(uuid, timestamptz)
  OWNER TO reachagent_function_owner;

-- New workspace-scoped overloads remain protected by table RLS for
-- authenticated callers. Legacy unscoped overloads are retained for service
-- diagnostics only and are no longer browser-callable.
REVOKE ALL ON FUNCTION public.get_leads_search_page(text[], text, text, text, integer, integer, boolean) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_lifecycle_page(timestamptz, text, text, text, text, integer, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_pipeline_search_page(text[], text, integer, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_deals_search_page(text, integer, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_dm_queue_search_page(text, text, text, text, integer, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_email_log_search_page(text, text, text, integer, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_delivery_failure_report(text, text, text, integer, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_delivery_failure_lead_selection(text, text, text, boolean) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.get_leads_search_page(uuid, text[], text, text, text, integer, integer, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_lifecycle_page(uuid, timestamptz, text, text, text, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_pipeline_search_page(uuid, text[], text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_deals_search_page(uuid, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_dm_queue_search_page(uuid, text, text, text, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_email_log_search_page(uuid, text, text, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_delivery_failure_report(uuid, text, text, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_delivery_failure_lead_selection(uuid, text, text, text, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_list_workspace_directory_page(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_workspace_directory_page(text, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.get_settings_performance_summary(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_settings_performance_summary(uuid, timestamptz) TO service_role;

REVOKE CREATE ON SCHEMA public FROM reachagent_function_owner;
REVOKE reachagent_function_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
