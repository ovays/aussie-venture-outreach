-- Literal, case-insensitive partial search for dashboard list pages. Every RPC
-- remains SECURITY INVOKER so the caller's existing RLS policies still apply.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- CREATE EXTENSION IF NOT EXISTS does not move an existing extension. Resolve
-- the operator class from the schema where this Supabase project installed it.
DO $migration$
DECLARE
  pg_trgm_schema NAME;
BEGIN
  SELECT nsp.nspname
  INTO pg_trgm_schema
  FROM pg_catalog.pg_extension AS ext
  JOIN pg_catalog.pg_namespace AS nsp
    ON nsp.oid = ext.extnamespace
  WHERE ext.extname = 'pg_trgm';

  IF pg_trgm_schema IS NULL THEN
    RAISE EXCEPTION 'pg_trgm extension is not installed';
  END IF;

  EXECUTE pg_catalog.format(
    'CREATE INDEX IF NOT EXISTS leads_business_name_trgm_idx ON public.leads USING gin (business_name %I.gin_trgm_ops)',
    pg_trgm_schema
  );
  EXECUTE pg_catalog.format(
    'CREATE INDEX IF NOT EXISTS leads_email_trgm_idx ON public.leads USING gin (email %I.gin_trgm_ops) WHERE email IS NOT NULL',
    pg_trgm_schema
  );
  EXECUTE pg_catalog.format(
    'CREATE INDEX IF NOT EXISTS emails_subject_trgm_idx ON public.emails USING gin (subject %I.gin_trgm_ops)',
    pg_trgm_schema
  );
  EXECUTE pg_catalog.format(
    'CREATE INDEX IF NOT EXISTS dm_queue_handle_trgm_idx ON public.dm_queue USING gin (handle %I.gin_trgm_ops)',
    pg_trgm_schema
  );
END;
$migration$;

CREATE OR REPLACE FUNCTION public.literal_ilike_pattern(p_search TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT '%' || pg_catalog.replace(
    pg_catalog.replace(
      pg_catalog.replace(pg_catalog.btrim(COALESCE(p_search, '')), E'\\', E'\\\\'),
      '%', E'\\%'
    ),
    '_', E'\\_'
  ) || '%';
$function$;

REVOKE ALL ON FUNCTION public.literal_ilike_pattern(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.literal_ilike_pattern(TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_leads_search_page(
  p_statuses TEXT[] DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_city TEXT DEFAULT NULL,
  p_search TEXT DEFAULT '',
  p_page INTEGER DEFAULT 1,
  p_page_size INTEGER DEFAULT 50,
  p_ids_only BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
WITH validated AS (
  SELECT
    pg_catalog.btrim(COALESCE(p_search, '')) AS search_term,
    GREATEST(COALESCE(p_page, 1), 1) AS page_number,
    LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 1000) AS page_size
), matched AS MATERIALIZED (
  SELECT leads.*
  FROM public.leads AS leads
  CROSS JOIN validated
  WHERE (p_statuses IS NULL OR leads.status = ANY (p_statuses))
    AND (p_category IS NULL OR leads.category_name = p_category)
    AND (p_city IS NULL OR leads.city = p_city)
    AND (
      validated.search_term = ''
      OR leads.business_name ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
      OR COALESCE(leads.email, '') ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
    )
), paged AS (
  SELECT matched.*
  FROM matched CROSS JOIN validated
  ORDER BY matched.created_at DESC, matched.id ASC
  OFFSET ((SELECT page_number - 1 FROM validated) * (SELECT page_size FROM validated))
  LIMIT (SELECT page_size FROM validated)
), rows AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(
    CASE WHEN p_ids_only
      THEN pg_catalog.jsonb_build_object('id', paged.id)
      ELSE pg_catalog.jsonb_build_object(
        'id', paged.id,
        'business_name', paged.business_name,
        'category_name', paged.category_name,
        'city', paged.city,
        'suburb', paged.suburb,
        'email', paged.email,
        'instagram_handle', paged.instagram_handle,
        'google_rating', paged.google_rating,
        'halal_confidence_score', paged.halal_confidence_score,
        'status', paged.status,
        'created_at', paged.created_at,
        'halal', paged.halal
      )
    END ORDER BY paged.created_at DESC, paged.id ASC
  ), '[]'::JSONB) AS data
  FROM paged
)
SELECT pg_catalog.jsonb_build_object(
  'data', rows.data,
  'total', (SELECT COUNT(*) FROM matched)
)
FROM rows;
$function$;

CREATE OR REPLACE FUNCTION public.get_pipeline_search_page(
  p_statuses TEXT[],
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
WITH validated AS (
  SELECT pg_catalog.btrim(COALESCE(p_search, '')) AS search_term,
    GREATEST(COALESCE(p_page, 1), 1) AS page_number,
    LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 100) AS page_size
), matched AS MATERIALIZED (
  SELECT leads.*
  FROM public.leads AS leads CROSS JOIN validated
  WHERE leads.status = ANY (COALESCE(p_statuses, ARRAY[]::TEXT[]))
    AND (
      validated.search_term = ''
      OR leads.business_name ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
      OR COALESCE(leads.email, '') ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
    )
), paged AS (
  SELECT matched.* FROM matched CROSS JOIN validated
  ORDER BY matched.created_at DESC, matched.id ASC
  OFFSET ((SELECT page_number - 1 FROM validated) * (SELECT page_size FROM validated))
  LIMIT (SELECT page_size FROM validated)
), rows AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', paged.id, 'business_name', paged.business_name,
    'category_name', paged.category_name, 'city', paged.city,
    'suburb', paged.suburb, 'status', paged.status,
    'deal_value', paged.deal_value, 'created_at', paged.created_at
  ) ORDER BY paged.created_at DESC, paged.id ASC), '[]'::JSONB) AS data
  FROM paged
)
SELECT pg_catalog.jsonb_build_object('data', rows.data, 'total', (SELECT COUNT(*) FROM matched)) FROM rows;
$function$;

CREATE OR REPLACE FUNCTION public.get_email_log_search_page(
  p_type TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
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
WITH validated AS (
  SELECT pg_catalog.btrim(COALESCE(p_search, '')) AS search_term,
    GREATEST(COALESCE(p_page, 1), 1) AS page_number,
    LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 100) AS page_size
), matched AS MATERIALIZED (
  SELECT emails.*, leads.business_name, leads.category_name, leads.city, leads.email AS recipient_email
  FROM public.emails AS emails
  LEFT JOIN public.leads AS leads ON leads.id = emails.lead_id
  CROSS JOIN validated
  WHERE (p_type IS NULL OR emails.type = p_type)
    AND (p_status IS NULL OR emails.status = p_status)
    AND (
      validated.search_term = ''
      OR emails.subject ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
      OR COALESCE(leads.business_name, '') ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
      OR COALESCE(leads.email, '') ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
    )
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
      'city', paged.city, 'email', paged.recipient_email
    ) END
  ) ORDER BY paged.created_at DESC, paged.id ASC), '[]'::JSONB) AS data
  FROM paged
)
SELECT pg_catalog.jsonb_build_object('data', rows.data, 'total', (SELECT COUNT(*) FROM matched)) FROM rows;
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
), bounded_email_rows AS (
  SELECT emails.status
  FROM public.emails AS emails
  LEFT JOIN public.leads AS leads ON leads.id = emails.lead_id
  CROSS JOIN validated
  WHERE (p_type IS NULL OR emails.type = p_type)
    AND (p_status IS NULL OR emails.status = p_status)
    AND (
      validated.search_term = ''
      OR emails.subject ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
      OR COALESCE(leads.business_name, '') ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
      OR COALESCE(leads.email, '') ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
    )
  ORDER BY emails.created_at DESC, emails.id ASC
  LIMIT 500
), bounce_count AS (
  SELECT COUNT(*) FILTER (WHERE bounded_email_rows.status = 'bounced')::BIGINT AS bounced FROM bounded_email_rows
)
SELECT pg_catalog.jsonb_build_object(
  'total_contacted_leads', lead_counts.contacted,
  'positive_response_leads', lead_counts.positive,
  'reply_rate', CASE WHEN lead_counts.contacted > 0 THEN pg_catalog.round(lead_counts.positive::NUMERIC / lead_counts.contacted::NUMERIC * 100)::INTEGER ELSE 0 END,
  'matching_bounced', bounce_count.bounced
)
FROM lead_counts CROSS JOIN bounce_count;
$function$;

CREATE OR REPLACE FUNCTION public.get_deals_search_page(
  p_search TEXT DEFAULT '', p_page INTEGER DEFAULT 1, p_page_size INTEGER DEFAULT 50
)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog
AS $function$
WITH validated AS (
  SELECT pg_catalog.btrim(COALESCE(p_search, '')) AS search_term,
    GREATEST(COALESCE(p_page, 1), 1) AS page_number,
    LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 100) AS page_size
), joined AS MATERIALIZED (
  SELECT deals.*, leads.business_name, leads.category_name, leads.city, leads.suburb, leads.email
  FROM public.deals AS deals LEFT JOIN public.leads AS leads ON leads.id = deals.lead_id
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
      'city', paged.city, 'suburb', paged.suburb, 'email', paged.email
    ) END
  ) ORDER BY paged.closed_at DESC, paged.id ASC), '[]'::JSONB) AS data FROM paged
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
  'summary', pg_catalog.to_jsonb(summary)
) FROM rows CROSS JOIN summary;
$function$;

CREATE OR REPLACE FUNCTION public.get_dm_queue_search_page(
  p_status TEXT DEFAULT NULL, p_platform TEXT DEFAULT NULL, p_city TEXT DEFAULT NULL,
  p_search TEXT DEFAULT '', p_page INTEGER DEFAULT 1, p_page_size INTEGER DEFAULT 50
)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog
AS $function$
WITH validated AS (
  SELECT pg_catalog.btrim(COALESCE(p_search, '')) AS search_term,
    GREATEST(COALESCE(p_page, 1), 1) AS page_number,
    LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 100) AS page_size
), matched AS MATERIALIZED (
  SELECT dm_queue.*, leads.business_name, leads.category_name, leads.city, leads.suburb
  FROM public.dm_queue AS dm_queue
  LEFT JOIN public.leads AS leads ON leads.id = dm_queue.lead_id
  CROSS JOIN validated
  WHERE (p_status IS NULL OR dm_queue.status = p_status)
    AND (p_platform IS NULL OR dm_queue.platform = p_platform)
    AND (p_city IS NULL OR leads.city = p_city)
    AND (
      validated.search_term = ''
      OR COALESCE(leads.business_name, '') ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
      OR dm_queue.handle ILIKE public.literal_ilike_pattern(validated.search_term) ESCAPE E'\\'
    )
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
      'business_name', paged.business_name, 'category_name', paged.category_name, 'city', paged.city
    ) END
  ) ORDER BY paged.created_at DESC, paged.id ASC), '[]'::JSONB) AS data FROM paged
)
SELECT pg_catalog.jsonb_build_object('data', rows.data, 'total', (SELECT COUNT(*) FROM matched)) FROM rows;
$function$;

REVOKE ALL ON FUNCTION public.get_leads_search_page(TEXT[], TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_pipeline_search_page(TEXT[], TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_email_log_search_page(TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_deals_search_page(TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_dm_queue_search_page(TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_leads_search_page(TEXT[], TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_pipeline_search_page(TEXT[], TEXT, INTEGER, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_email_log_search_page(TEXT, TEXT, TEXT, INTEGER, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_deals_search_page(TEXT, INTEGER, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_dm_queue_search_page(TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER) TO authenticated, service_role;
