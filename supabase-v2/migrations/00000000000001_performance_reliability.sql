-- ReachAgent V2 performance/reliability delta. The golden baseline is immutable.

-- This migration replaces one private function owned by the dedicated NOLOGIN
-- role. Hosted project credentials need temporary inheritable membership to
-- replace that function; the migration-issued grant is removed at the end.
GRANT reachagent_function_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;

-- Search RPCs are invoker functions and call this escaped-pattern helper.
GRANT EXECUTE ON FUNCTION public.literal_ilike_pattern(text) TO authenticated, service_role;

CREATE INDEX leads_category_status_created_at_idx
  ON public.leads (category_name, status, created_at DESC, id);

CREATE INDEX leads_business_city_idx
  ON public.leads (business_name, city);

CREATE INDEX leads_phone_not_null_idx
  ON public.leads (phone) WHERE phone IS NOT NULL;

CREATE FUNCTION public.finder_email_root_domain(p_email text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $$
  WITH domain_value AS (
    SELECT NULLIF(pg_catalog.lower(pg_catalog.rtrim(pg_catalog.btrim(pg_catalog.split_part(p_email, '@', 2)), '.')), '') AS domain
  ), public_provider AS (
    SELECT provider
    FROM domain_value, pg_catalog.unnest(ARRAY[
      'internode.on.net','googlemail.com','hotmail.com.au','outlook.com.au','live.com.au',
      'yahoo.com.au','bigpond.net.au','optusnet.com.au','protonmail.com','bigpond.com',
      'gmail.com','hotmail.com','outlook.com','icloud.com','proton.me','iinet.net.au',
      'live.com','yahoo.com','me.com','mac.com','aol.com','tpg.com.au'
    ]::text[]) AS provider
    WHERE domain = provider OR domain LIKE '%.' || provider
    ORDER BY pg_catalog.length(provider) DESC
    LIMIT 1
  ), parts AS (
    SELECT domain, pg_catalog.string_to_array(domain, '.') AS labels
    FROM domain_value WHERE domain IS NOT NULL
  )
  SELECT COALESCE(
    (SELECT provider FROM public_provider),
    CASE
      WHEN pg_catalog.array_length(labels, 1) < 2 THEN NULL
      WHEN labels[pg_catalog.array_length(labels, 1)-1] || '.' || labels[pg_catalog.array_length(labels, 1)]
        IN ('com.au','net.au','org.au','edu.au','gov.au','asn.au','id.au','co.nz','org.nz','net.nz','co.uk','org.uk','ac.uk')
        AND pg_catalog.array_length(labels, 1) >= 3
      THEN labels[pg_catalog.array_length(labels, 1)-2] || '.' || labels[pg_catalog.array_length(labels, 1)-1] || '.' || labels[pg_catalog.array_length(labels, 1)]
      ELSE labels[pg_catalog.array_length(labels, 1)-1] || '.' || labels[pg_catalog.array_length(labels, 1)]
    END
  ) FROM parts;
$$;

CREATE FUNCTION public.finder_website_domain(p_website text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $$
  SELECT NULLIF(pg_catalog.split_part(
    pg_catalog.regexp_replace(
      pg_catalog.lower(pg_catalog.split_part(
        pg_catalog.regexp_replace(pg_catalog.btrim(p_website), '^[a-z][a-z0-9+.-]*://', '', 'i'), '/', 1
      )), '^www\.', ''
    ), ':', 1
  ), '');
$$;

CREATE INDEX leads_finder_email_root_domain_idx
  ON public.leads (public.finder_email_root_domain(normalized_email))
  WHERE normalized_email IS NOT NULL;

CREATE INDEX leads_finder_website_domain_idx
  ON public.leads (public.finder_website_domain(website))
  WHERE website IS NOT NULL;

-- One durable intent per lead/phase may be pending or delivered. Failed sends
-- are terminal and permit a later explicitly-created retry intent.
CREATE UNIQUE INDEX emails_lead_type_open_or_delivered_key
  ON public.emails (lead_id, type)
  WHERE status IN ('pending_send', 'sent', 'email_sync_failed');

CREATE OR REPLACE FUNCTION public.lookup_finder_candidates(p_candidates jsonb)
RETURNS TABLE (
  candidate_index integer,
  matched_id uuid,
  matched_business_name text,
  matched_email text,
  matched_status text,
  matched_suppression_reason text,
  match_type text
)
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog'
AS $$
  WITH candidates AS (
    SELECT
      candidate_index,
      NULLIF(pg_catalog.btrim(business_name), '') AS business_name,
      NULLIF(pg_catalog.btrim(city), '') AS city,
      NULLIF(pg_catalog.btrim(phone), '') AS phone,
      NULLIF(pg_catalog.lower(pg_catalog.btrim(email)), '') AS normalized_email,
      NULLIF(pg_catalog.btrim(email_root_domain), '') AS email_root_domain,
      COALESCE(is_public_email_domain, false) AS is_public_email_domain,
      NULLIF(pg_catalog.lower(pg_catalog.btrim(website_domain)), '') AS website_domain
    FROM pg_catalog.jsonb_to_recordset(COALESCE(p_candidates, '[]'::jsonb)) AS candidate(
      candidate_index integer,
      business_name text,
      city text,
      phone text,
      email text,
      email_root_domain text,
      is_public_email_domain boolean,
      website_domain text
    )
    LIMIT 500
  )
  SELECT
    candidates.candidate_index,
    matched.id,
    matched.business_name,
    matched.email,
    matched.status,
    matched.outreach_suppression_reason,
    matched.match_type
  FROM candidates
  LEFT JOIN LATERAL (
    SELECT leads.id, leads.business_name, leads.email, leads.status,
      leads.outreach_suppression_reason,
      CASE
        WHEN leads.business_name = candidates.business_name AND leads.city = candidates.city THEN 'business_city'
        WHEN candidates.phone IS NOT NULL AND leads.phone = candidates.phone THEN 'phone'
        WHEN candidates.normalized_email IS NOT NULL AND leads.normalized_email = candidates.normalized_email THEN 'normalized_email'
        WHEN candidates.website_domain IS NOT NULL AND public.finder_website_domain(leads.website) = candidates.website_domain THEN 'website_domain'
        ELSE 'email_domain'
      END AS match_type
    FROM public.leads AS leads
    WHERE (leads.business_name = candidates.business_name AND leads.city = candidates.city)
       OR (candidates.phone IS NOT NULL AND leads.phone = candidates.phone)
       OR (candidates.normalized_email IS NOT NULL AND leads.normalized_email = candidates.normalized_email)
       OR (candidates.website_domain IS NOT NULL AND leads.website IS NOT NULL
         AND public.finder_website_domain(leads.website) = candidates.website_domain)
       OR (NOT candidates.is_public_email_domain AND candidates.email_root_domain IS NOT NULL
         AND leads.normalized_email IS NOT NULL
         AND public.finder_email_root_domain(leads.normalized_email) = candidates.email_root_domain)
    ORDER BY leads.created_at, leads.id
    LIMIT 1
  ) AS matched ON TRUE
  ORDER BY candidates.candidate_index;
$$;

REVOKE ALL ON FUNCTION public.lookup_finder_candidates(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_finder_candidates(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.finder_email_root_domain(text), public.finder_website_domain(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finder_email_root_domain(text), public.finder_website_domain(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.insert_finder_lead_if_new(p_lead jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'pg_catalog'
AS $$
DECLARE
  v_email text := NULLIF(pg_catalog.lower(pg_catalog.btrim(p_lead->>'email')), '');
  v_email_root text := public.finder_email_root_domain(p_lead->>'email');
  v_website_domain text := public.finder_website_domain(p_lead->>'website');
  v_public_email boolean := COALESCE((p_lead->>'is_public_email_domain')::boolean, false);
  v_match public.leads%ROWTYPE;
  v_inserted public.leads%ROWTYPE;
BEGIN
  IF NULLIF(pg_catalog.btrim(p_lead->>'business_name'), '') IS NULL
     OR NULLIF(pg_catalog.btrim(p_lead->>'city'), '') IS NULL
     OR v_email IS NULL THEN
    RAISE EXCEPTION 'invalid Finder lead candidate';
  END IF;

  -- Finder batches are small and inserts are short. One transaction-scoped
  -- mutex makes the recheck atomic across every identity dimension (including
  -- same place with different emails), while never blocking manual/API leads.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('reachagent_finder_insert', 0)
  );

  SELECT leads.* INTO v_match
  FROM public.leads AS leads
  WHERE (leads.business_name = pg_catalog.btrim(p_lead->>'business_name') AND leads.city = pg_catalog.btrim(p_lead->>'city'))
     OR (NULLIF(pg_catalog.btrim(p_lead->>'phone'), '') IS NOT NULL AND leads.phone = pg_catalog.btrim(p_lead->>'phone'))
     OR leads.normalized_email = v_email
     OR (v_website_domain IS NOT NULL AND leads.website IS NOT NULL
       AND public.finder_website_domain(leads.website) = v_website_domain)
     OR (NOT v_public_email AND v_email_root IS NOT NULL AND leads.normalized_email IS NOT NULL
       AND public.finder_email_root_domain(leads.normalized_email) = v_email_root)
  ORDER BY leads.created_at, leads.id
  LIMIT 1;

  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'inserted', false,
      'match', pg_catalog.jsonb_build_object(
        'id', v_match.id, 'business_name', v_match.business_name,
        'email', v_match.email, 'status', v_match.status,
        'outreach_suppression_reason', v_match.outreach_suppression_reason
      )
    );
  END IF;

  INSERT INTO public.leads (
    business_name, category_id, category_name, city, state, phone, email,
    website, address, google_rating, google_reviews_count,
    halal_confidence_score, halal_reasons, status, outreach_channel,
    content_type, source
  ) VALUES (
    pg_catalog.btrim(p_lead->>'business_name'), NULLIF(p_lead->>'category_id', '')::uuid,
    pg_catalog.btrim(p_lead->>'category_name'), pg_catalog.btrim(p_lead->>'city'),
    NULLIF(pg_catalog.btrim(p_lead->>'state'), ''), NULLIF(pg_catalog.btrim(p_lead->>'phone'), ''),
    v_email, NULLIF(pg_catalog.btrim(p_lead->>'website'), ''),
    NULLIF(pg_catalog.btrim(p_lead->>'address'), ''), NULLIF(p_lead->>'google_rating', '')::numeric,
    NULLIF(p_lead->>'google_reviews_count', '')::integer,
    NULLIF(p_lead->>'halal_confidence_score', '')::integer,
    CASE WHEN p_lead->'halal_reasons' IS NULL OR p_lead->'halal_reasons' = 'null'::jsonb THEN NULL ELSE p_lead->'halal_reasons' END,
    'new', 'email', COALESCE(NULLIF(p_lead->>'content_type', ''), 'remote'), 'finder'
  ) RETURNING * INTO v_inserted;

  RETURN pg_catalog.jsonb_build_object(
    'inserted', true,
    'lead', pg_catalog.jsonb_build_object(
      'id', v_inserted.id, 'business_name', v_inserted.business_name,
      'email', v_inserted.email, 'status', v_inserted.status
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.insert_finder_lead_if_new(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_finder_lead_if_new(jsonb) TO service_role;

-- Keep the exact count and requested page in one call, but materialize only
-- list fields rather than every wide leads column.
CREATE OR REPLACE FUNCTION public.get_leads_search_page(
  p_statuses text[] DEFAULT NULL::text[],
  p_category text DEFAULT NULL::text,
  p_city text DEFAULT NULL::text,
  p_search text DEFAULT ''::text,
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
  WHERE (
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
SELECT pg_catalog.jsonb_build_object(
  'data', rows.data,
  'total', (SELECT COUNT(*) FROM matched)
) FROM rows;
$$;

-- Data Quality classification remains trigger-maintained. Build the report
-- from open flags and enrich only flagged leads instead of recomputing facts
-- for the complete historical lead/email/deal population on every page load.
CREATE OR REPLACE FUNCTION reachagent_private.get_data_quality_report_v2(
  p_issue_type text DEFAULT NULL::text,
  p_search text DEFAULT NULL::text,
  p_email text DEFAULT NULL::text,
  p_business text DEFAULT NULL::text,
  p_category text DEFAULT NULL::text,
  p_city text DEFAULT NULL::text,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 50
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
WITH open_flags AS MATERIALIZED (
  SELECT f.*
  FROM public.lead_data_quality_flags AS f
  WHERE f.status = 'open'
    AND (p_issue_type IS NULL OR f.issue_type = p_issue_type)
), flagged_ids AS MATERIALIZED (
  SELECT DISTINCT lead_id FROM open_flags
), lead_facts AS MATERIALIZED (
  SELECT l.*,
    public.data_quality_website_identity(l.website) AS norm_domain,
    COUNT(DISTINCT e.id) FILTER (WHERE e.status IN ('sent','email_sync_failed'))::int AS outreach_count,
    COUNT(DISTINCT e.id)::int AS all_email_count,
    MAX(COALESCE(e.sent_at,e.created_at)) FILTER (WHERE e.status IN ('sent','email_sync_failed')) AS latest_outreach_at,
    bool_or(e.replied_at IS NOT NULL) AS email_has_reply,
    bool_or(d.id IS NOT NULL) AS has_deal
  FROM flagged_ids AS candidate
  JOIN public.leads AS l ON l.id = candidate.lead_id
  LEFT JOIN public.emails AS e ON e.lead_id = l.id
  LEFT JOIN public.deals AS d ON d.lead_id = l.id
  GROUP BY l.id
), grouped AS (
  SELECT f.normalized_email, f.issue_type,
    COUNT(*)::int AS lead_count,
    array_agg(l.id ORDER BY l.created_at,l.id) AS lead_ids,
    array_agg(l.business_name ORDER BY l.created_at,l.id) AS business_names,
    array_agg(l.status ORDER BY l.created_at,l.id) AS statuses,
    SUM(l.outreach_count)::int AS outreach_count,
    MAX(l.latest_outreach_at) AS latest_outreach_at,
    bool_or(l.email_has_reply OR l.status IN ('replied','negotiating','interested')) AS has_reply,
    bool_or(l.has_deal OR l.status IN ('closed','closed_manual')) AS has_deal,
    bool_or(NULLIF(btrim(l.notes),'') IS NOT NULL) AS has_notes,
    bool_or(l.all_email_count > 0) AS has_email_history,
    (array_agg(l.id ORDER BY
      (l.email_has_reply OR l.has_deal OR l.status IN ('replied','negotiating','interested','closed','closed_manual')) DESC,
      CASE l.status WHEN 'closed' THEN 65 WHEN 'closed_manual' THEN 65 WHEN 'negotiating' THEN 60
        WHEN 'interested' THEN 55 WHEN 'replied' THEN 50 WHEN 'contacted' THEN 30 WHEN 'email_ready' THEN 20
        WHEN 'researched' THEN 10 ELSE 0 END DESC,
      l.outreach_count DESC,
      num_nonnulls(l.business_name,l.website,l.phone,l.address,l.suburb,l.instagram_handle) DESC,
      l.created_at,l.id))[1] AS preferred_lead_id,
    array_agg(DISTINCT l.category_name) AS categories,
    array_agg(DISTINCT l.city) AS cities,
    array_agg(DISTINCT l.norm_domain) AS domains,
    COALESCE(
      ARRAY(SELECT jsonb_array_elements_text((array_agg(f.metadata ORDER BY f.created_at))[1]->'signals')),
      ARRAY[(array_agg(f.reason ORDER BY f.created_at))[1]]
    ) AS reasons
  FROM open_flags AS f
  JOIN lead_facts AS l ON l.id = f.lead_id
  WHERE f.issue_type IN ('duplicate_lead','shared_email','uncertain_email_group')
  GROUP BY f.normalized_email,f.issue_type
), flag_issues AS (
  SELECT f.normalized_email,f.issue_type,1::int AS lead_count,ARRAY[l.id] AS lead_ids,
    ARRAY[l.business_name] AS business_names,ARRAY[l.status] AS statuses,
    l.outreach_count,l.latest_outreach_at,
    (l.status IN ('replied','negotiating','interested') OR l.email_has_reply) AS has_reply,
    (l.has_deal OR l.status IN ('closed','closed_manual')) AS has_deal,
    NULLIF(btrim(l.notes),'') IS NOT NULL AS has_notes,l.all_email_count > 0 AS has_email_history,
    l.id AS preferred_lead_id,ARRAY[l.category_name] AS categories,ARRAY[l.city] AS cities,
    ARRAY[l.norm_domain] AS domains,ARRAY[f.reason] AS reasons
  FROM open_flags AS f
  JOIN lead_facts AS l ON l.id = f.lead_id
  WHERE f.issue_type IN ('invalid_email','placeholder_email','technical_email','already_contacted_email')
), issues AS (
  SELECT normalized_email,issue_type,lead_count,lead_ids,business_names,statuses,outreach_count,latest_outreach_at,
    has_reply,has_deal,has_notes,has_email_history,false AS has_booking,
    (has_reply OR has_deal OR has_notes OR has_email_history) AS protected_from_auto_delete,
    preferred_lead_id,array_remove(lead_ids,preferred_lead_id) AS suggested_redundant_lead_ids,
    categories,cities,domains,reasons
  FROM grouped
  UNION ALL
  SELECT normalized_email,issue_type,lead_count,lead_ids,business_names,statuses,outreach_count,latest_outreach_at,
    has_reply,has_deal,has_notes,has_email_history,false,
    (has_reply OR has_deal OR has_notes OR has_email_history),preferred_lead_id,ARRAY[]::uuid[],
    categories,cities,domains,reasons
  FROM flag_issues
), filtered AS MATERIALIZED (
  SELECT * FROM issues
  WHERE (p_search IS NULL OR normalized_email ILIKE '%'||btrim(p_search)||'%'
      OR array_to_string(business_names,' ') ILIKE '%'||btrim(p_search)||'%'
      OR array_to_string(domains,' ') ILIKE '%'||btrim(p_search)||'%')
    AND (p_email IS NULL OR normalized_email ILIKE '%'||lower(btrim(p_email))||'%')
    AND (p_business IS NULL OR array_to_string(business_names,' ') ILIKE '%'||btrim(p_business)||'%')
    AND (p_category IS NULL OR EXISTS (SELECT 1 FROM unnest(categories) value WHERE value ILIKE btrim(p_category)))
    AND (p_city IS NULL OR EXISTS (SELECT 1 FROM unnest(cities) value WHERE value ILIKE btrim(p_city)))
), paged AS (
  SELECT * FROM filtered
  ORDER BY latest_outreach_at DESC NULLS LAST,normalized_email,issue_type
  LIMIT LEAST(GREATEST(p_page_size,1),100)
  OFFSET (GREATEST(p_page,1)-1)*LEAST(GREATEST(p_page_size,1),100)
)
SELECT jsonb_build_object(
  'data',COALESCE(jsonb_agg(to_jsonb(paged)),'[]'::jsonb),
  'total',(SELECT COUNT(*) FROM filtered),
  'page',GREATEST(p_page,1),
  'page_size',LEAST(GREATEST(p_page_size,1),100)
) FROM paged;
$$;

-- Lifecycle totals and derived-sort semantics require classifying the eligible
-- population. Reduce that unavoidable work by keeping its materialized lead
-- CTE narrow and excluding unsent/unrelated email rows before aggregation.
DO $migration$
DECLARE
  v_oid regprocedure := 'public.get_lifecycle_page(timestamptz,text,text,text,text,integer,integer)'::regprocedure;
  v_definition text;
  v_optimized text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(v_oid) INTO v_definition;
  v_optimized := pg_catalog.replace(
    v_definition,
    '  SELECT leads.*',
    '  SELECT leads.id, leads.business_name, leads.email, leads.status, leads.reactivation_sent_at'
  );
  IF v_optimized = v_definition THEN
    RAISE EXCEPTION 'get_lifecycle_page candidate projection no longer matches the verified baseline';
  END IF;
  v_definition := v_optimized;
  v_optimized := pg_catalog.replace(
    v_definition,
    '  LEFT JOIN public.emails AS emails ON emails.lead_id = leads.id',
    '  LEFT JOIN public.emails AS emails ON emails.lead_id = leads.id
    AND emails.sent_at IS NOT NULL
    AND emails.type IN (''initial_pitch'', ''follow_up_1'', ''follow_up_2'', ''follow_up_3'')'
  );
  IF v_optimized = v_definition THEN
    RAISE EXCEPTION 'get_lifecycle_page email join no longer matches the verified baseline';
  END IF;
  EXECUTE v_optimized;
END
$migration$;

REVOKE reachagent_function_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
