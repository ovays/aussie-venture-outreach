-- Prompt 4: durable customer business outcomes and a customer-safe lead projection.
-- Raw lead statuses and all pipeline behaviour remain unchanged.

ALTER TABLE public.leads
  ADD COLUMN customer_outcome text;

ALTER TABLE public.leads
  ADD CONSTRAINT leads_customer_outcome_check
  CHECK (
    customer_outcome IS NULL
    OR customer_outcome IN ('interested', 'not_interested')
  );

CREATE INDEX leads_workspace_customer_outcome_idx
  ON public.leads (workspace_id, customer_outcome)
  WHERE customer_outcome IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_customer_leads_page(
  p_workspace_id uuid,
  p_status text DEFAULT 'all',
  p_search text DEFAULT '',
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 25,
  p_as_of timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
WITH validated AS (
  SELECT
    CASE
      WHEN p_status IN (
        'all',
        'new',
        'email_ready',
        'contacted',
        'replied',
        'interested',
        'not_interested',
        'reactivation_due',
        'dead'
      )
      THEN p_status
      ELSE 'all'
    END AS status_filter,

    pg_catalog.btrim(COALESCE(p_search, '')) AS search_term,

    GREATEST(
      COALESCE(p_page, 1),
      1
    ) AS page_number,

    LEAST(
      GREATEST(
        COALESCE(p_page_size, 25),
        1
      ),
      50
    ) AS page_size

), settings AS (
  SELECT
    COALESCE(
      (
        SUBSTRING(
          MAX(value) FILTER (
            WHERE key = 'reactivation_delay_days'
          )
          FROM '^[+-]?[0-9]+'
        )
      )::integer,
      60
    ) AS react_days,

    COALESCE(
      MAX(value) FILTER (
        WHERE key = 'reactivation_enabled'
      ) = 'true',
      false
    ) AS react_enabled

  FROM public.workspace_settings
  WHERE workspace_id = p_workspace_id

), facts AS MATERIALIZED (
  SELECT
    l.id,
    l.business_name,
    l.category_name,
    l.city,
    l.suburb,
    l.email,
    l.status AS raw_status,
    l.customer_outcome,
    l.created_at,

    MAX(e.sent_at) FILTER (
      WHERE e.sent_at IS NOT NULL
    ) AS last_contact_at,

    BOOL_OR(
      e.replied_at IS NOT NULL
    ) AS has_reply,

    (
      ARRAY_AGG(
        e.sent_at
        ORDER BY e.created_at, e.id
      ) FILTER (
        WHERE e.type = 'initial_pitch'
          AND e.sent_at IS NOT NULL
      )
    )[1] AS initial_sent_at,

    COALESCE(
      BOOL_OR(
        e.sent_at IS NOT NULL
      ) FILTER (
        WHERE e.type = 'follow_up_1'
      ),
      false
    ) AS fu1_sent,

    COALESCE(
      BOOL_OR(
        e.sent_at IS NOT NULL
      ) FILTER (
        WHERE e.type = 'follow_up_2'
      ),
      false
    ) AS fu2_sent,

    COALESCE(
      BOOL_OR(
        e.sent_at IS NOT NULL
      ) FILTER (
        WHERE e.type = 'follow_up_3'
      ),
      false
    ) AS fu3_sent

  FROM public.leads l

  LEFT JOIN public.emails e
    ON e.workspace_id = p_workspace_id
   AND e.lead_id = l.id

  WHERE l.workspace_id = p_workspace_id

  GROUP BY l.id

), classified AS MATERIALIZED (
  SELECT
    facts.*,

    CASE
      WHEN customer_outcome = 'not_interested'
        THEN 'not_interested'

      WHEN customer_outcome = 'interested'
        THEN 'interested'

      WHEN raw_status = 'contacted'
        AND settings.react_enabled
        AND initial_sent_at IS NOT NULL
        AND fu1_sent
        AND fu2_sent
        AND fu3_sent
        AND initial_sent_at
          + pg_catalog.make_interval(
              days => settings.react_days
            ) <= p_as_of
        THEN 'reactivation_due'

      WHEN raw_status = 'email_ready'
        THEN 'email_ready'

      WHEN raw_status = 'contacted'
        THEN 'contacted'

      WHEN raw_status = 'replied'
        THEN 'replied'

      WHEN raw_status IN (
        'interested',
        'negotiating',
        'closed',
        'closed_manual'
      )
        THEN 'interested'

      WHEN raw_status = 'dead'
        THEN 'dead'

      ELSE 'new'
    END AS customer_status

  FROM facts
  CROSS JOIN settings

), searched AS MATERIALIZED (
  SELECT
    classified.*

  FROM classified
  CROSS JOIN validated

  WHERE (
    validated.search_term = ''

    OR business_name ILIKE
      '%' || public.literal_ilike_pattern(validated.search_term) || '%'
      ESCAPE E'\\'

    OR COALESCE(email, '') ILIKE
      '%' || public.literal_ilike_pattern(validated.search_term) || '%'
      ESCAPE E'\\'

    OR COALESCE(city, '') ILIKE
      '%' || public.literal_ilike_pattern(validated.search_term) || '%'
      ESCAPE E'\\'

    OR COALESCE(suburb, '') ILIKE
      '%' || public.literal_ilike_pattern(validated.search_term) || '%'
      ESCAPE E'\\'

    OR COALESCE(category_name, '') ILIKE
      '%' || public.literal_ilike_pattern(validated.search_term) || '%'
      ESCAPE E'\\'
  )

), matched AS MATERIALIZED (
  SELECT
    searched.*

  FROM searched
  CROSS JOIN validated

  WHERE validated.status_filter = 'all'
     OR searched.customer_status = validated.status_filter

), paged AS (
  SELECT
    matched.*

  FROM matched

  ORDER BY
    matched.created_at DESC NULLS LAST,
    matched.id

  OFFSET (
    SELECT ((page_number - 1) * page_size)
    FROM validated
  )

  LIMIT (
    SELECT page_size
    FROM validated
  )

), counts AS (
  SELECT
    pg_catalog.jsonb_build_object(
      'all', COUNT(*),

      'new',
      COUNT(*) FILTER (
        WHERE customer_status = 'new'
      ),

      'email_ready',
      COUNT(*) FILTER (
        WHERE customer_status = 'email_ready'
      ),

      'contacted',
      COUNT(*) FILTER (
        WHERE customer_status = 'contacted'
      ),

      'replied',
      COUNT(*) FILTER (
        WHERE customer_status = 'replied'
      ),

      'interested',
      COUNT(*) FILTER (
        WHERE customer_status = 'interested'
      ),

      'not_interested',
      COUNT(*) FILTER (
        WHERE customer_status = 'not_interested'
      ),

      'reactivation_due',
      COUNT(*) FILTER (
        WHERE customer_status = 'reactivation_due'
      ),

      'dead',
      COUNT(*) FILTER (
        WHERE customer_status = 'dead'
      )
    ) AS value

  FROM searched

), records AS (
  SELECT
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', id,
          'business_name', business_name,
          'category_name', category_name,
          'location',
            pg_catalog.concat_ws(
              ', ',
              NULLIF(suburb, ''),
              NULLIF(city, '')
            ),
          'email', email,
          'customer_status', customer_status,
          'last_contact_at', last_contact_at,
          'has_reply', has_reply
        )
        ORDER BY
          created_at DESC NULLS LAST,
          id
      ),
      '[]'::jsonb
    ) AS value

  FROM paged

), recent_activity AS (
  SELECT
    COALESCE(
      pg_catalog.jsonb_agg(
        row_value
        ORDER BY created_at DESC
      ),
      '[]'::jsonb
    ) AS value

  FROM (
    SELECT
      a.created_at,

      pg_catalog.jsonb_build_object(
        'id', a.id,
        'created_at', a.created_at,
        'event_type', a.event_type,
        'business_name', l.business_name
      ) AS row_value

    FROM public.activity_log a

    JOIN public.leads l
      ON l.id = a.lead_id
     AND l.workspace_id = p_workspace_id

    WHERE a.workspace_id = p_workspace_id
      AND a.event_type IN (
        'lead_found',
        'lead_created',
        'email_sent',
        'follow_up_1_sent',
        'follow_up_2_sent',
        'follow_up_3_sent',
        'reply_received',
        'customer_outcome_interested',
        'customer_outcome_not_interested',
        'customer_outcome_cleared'
      )

    ORDER BY a.created_at DESC

    LIMIT 20
  ) safe_events
)

SELECT
  pg_catalog.jsonb_build_object(
    'data',
    records.value,

    'total',
    (SELECT COUNT(*) FROM matched),

    'page',
    validated.page_number,

    'page_size',
    validated.page_size,

    'counts',
    counts.value,

    'recent_activity',
    recent_activity.value
  )

FROM validated
CROSS JOIN records
CROSS JOIN counts
CROSS JOIN recent_activity;
$$;


REVOKE ALL
ON FUNCTION public.get_customer_leads_page(
  uuid,
  text,
  text,
  integer,
  integer,
  timestamptz
)
FROM PUBLIC;


GRANT EXECUTE
ON FUNCTION public.get_customer_leads_page(
  uuid,
  text,
  text,
  integer,
  integer,
  timestamptz
)
TO service_role;


COMMENT ON COLUMN public.leads.customer_outcome IS
  'Workspace customer business outcome only; never controls raw workflow status or pipeline execution.';