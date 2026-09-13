-- Keep lifecycle statuses unchanged while allowing the Leads UI to distinguish
-- normal researched leads from recipients already suppressed by backend rules.
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
  WHERE (
      p_statuses IS NULL
      OR (
        'suppressed' = ANY (p_statuses)
        AND (
          leads.outreach_suppressed_at IS NOT NULL
          OR leads.outreach_suppression_reason IS NOT NULL
          OR COALESCE(
            NULLIF(pg_catalog.lower(pg_catalog.btrim(leads.email)), '') = ANY (leads.delivery_suppressed_emails),
            false
          )
        )
      )
      OR (
        leads.status = ANY (p_statuses)
        AND NOT (
          p_statuses = ARRAY['researched']::TEXT[]
          AND (
            leads.outreach_suppressed_at IS NOT NULL
            OR leads.outreach_suppression_reason IS NOT NULL
            OR COALESCE(
              NULLIF(pg_catalog.lower(pg_catalog.btrim(leads.email)), '') = ANY (leads.delivery_suppressed_emails),
              false
            )
          )
        )
      )
    )
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
        'halal', paged.halal,
        'delivery_suppressed_emails', paged.delivery_suppressed_emails,
        'outreach_suppression_reason', paged.outreach_suppression_reason,
        'outreach_suppressed_at', paged.outreach_suppressed_at
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

REVOKE ALL ON FUNCTION public.get_leads_search_page(TEXT[], TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_leads_search_page(TEXT[], TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN) TO authenticated, service_role;
