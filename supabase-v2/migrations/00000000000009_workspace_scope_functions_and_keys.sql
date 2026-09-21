-- ReachAgent SaaS 1B: workspace-scoped SECURITY DEFINER writers and natural keys.
--
-- Every SECURITY DEFINER writer that touches tenant-owned data now resolves or
-- accepts an explicit workspace_id. Recipient ownership, exhausted queries,
-- search cache, category name, and email lead/type slot uniqueness are
-- repartitioned by workspace_id at the same time as their conflict targets.

GRANT reachagent_function_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;

--
-- Leads data-quality trigger now forwards workspace_id to the email-group refresh.
--

CREATE OR REPLACE FUNCTION public.trigger_refresh_lead_data_quality() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.normalized_email IS DISTINCT FROM NEW.normalized_email THEN
    PERFORM reachagent_private.refresh_email_group_quality(OLD.workspace_id, OLD.normalized_email);
  END IF;
  PERFORM reachagent_private.refresh_lead_data_quality(NEW.id);
  RETURN NEW;
END
$$;

ALTER FUNCTION public.trigger_refresh_lead_data_quality() OWNER TO reachagent_function_owner;

--
-- refresh_email_group_quality(uuid, text): workspace-scoped.
--

DROP FUNCTION IF EXISTS reachagent_private.refresh_email_group_quality(text);

CREATE OR REPLACE FUNCTION reachagent_private.refresh_email_group_quality(p_workspace_id uuid, p_email text) RETURNS void
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE v_count INT; v_type TEXT; v_reasons TEXT[]; v_ids UUID[]; v_leads JSONB; v_result JSONB;
BEGIN
  IF p_email IS NULL OR p_workspace_id IS NULL THEN RETURN; END IF;
  DELETE FROM lead_data_quality_flags WHERE workspace_id = p_workspace_id AND normalized_email = p_email AND status = 'open'
    AND issue_type IN ('duplicate_lead','shared_email','uncertain_email_group');
  SELECT COUNT(*)::INT, array_agg(id ORDER BY created_at),
    jsonb_agg(jsonb_build_object('business_name',business_name,'website',website,'phone',phone,
      'address',address,'suburb',suburb,'instagram_handle',instagram_handle) ORDER BY created_at,id)
  INTO v_count, v_ids, v_leads
  FROM leads
  WHERE workspace_id = p_workspace_id AND normalized_email = p_email;
  IF v_count < 2 THEN RETURN; END IF;
  v_result := public.classify_data_quality_group(v_leads);
  v_type := v_result->>'issue_type';
  SELECT array_agg(value) INTO v_reasons FROM jsonb_array_elements_text(v_result->'reasons') value;
  INSERT INTO lead_data_quality_flags(workspace_id, lead_id, normalized_email, issue_type, reason, related_lead_ids, metadata)
  SELECT p_workspace_id, id, p_email, v_type, array_to_string(v_reasons,', '), array_remove(v_ids,id), jsonb_build_object('signals',v_reasons)
  FROM leads
  WHERE workspace_id = p_workspace_id AND normalized_email = p_email
  ON CONFLICT DO NOTHING;
END
$$;

ALTER FUNCTION reachagent_private.refresh_email_group_quality(uuid, text) OWNER TO reachagent_function_owner;

--
-- refresh_lead_data_quality(uuid): derives workspace_id from the lead.
--

CREATE OR REPLACE FUNCTION reachagent_private.refresh_lead_data_quality(p_lead_id uuid) RETURNS void
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'reachagent_private', 'public'
AS $$
DECLARE v_email TEXT; v_raw_email TEXT; v_workspace UUID; v_type TEXT; v_reason TEXT; v_owner UUID;
BEGIN
  SELECT normalized_email, email, workspace_id INTO v_email, v_raw_email, v_workspace FROM leads WHERE id = p_lead_id;
  DELETE FROM lead_data_quality_flags
  WHERE workspace_id = v_workspace AND lead_id = p_lead_id AND status = 'open'
    AND issue_type IN ('invalid_email','placeholder_email','technical_email');
  IF v_raw_email IS NOT NULL AND btrim(v_raw_email) <> '' THEN
    SELECT q.issue_type, q.reason INTO v_type, v_reason FROM classify_email_quality(v_raw_email) q LIMIT 1;
    IF v_type IS NOT NULL THEN
      INSERT INTO lead_data_quality_flags(workspace_id, lead_id, normalized_email, issue_type, reason)
      VALUES(v_workspace, p_lead_id, v_email, v_type, v_reason) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  SELECT owner_lead_id INTO v_owner FROM recipient_outreach_ownership
    WHERE workspace_id = v_workspace AND normalized_email = v_email AND state = 'active';
  DELETE FROM lead_data_quality_flags
  WHERE workspace_id = v_workspace AND lead_id = p_lead_id AND status = 'open'
    AND issue_type = 'already_contacted_email';
  IF v_owner IS NOT NULL AND v_owner <> p_lead_id THEN
    INSERT INTO lead_data_quality_flags(workspace_id, lead_id, normalized_email, issue_type, reason, related_lead_ids, metadata)
    VALUES(v_workspace, p_lead_id, v_email, 'already_contacted_email',
      'Another lead owns the active outreach lifecycle for this recipient.', ARRAY[v_owner],
      jsonb_build_object('owner_lead_id', v_owner)) ON CONFLICT DO NOTHING;
  END IF;
  PERFORM reachagent_private.refresh_email_group_quality(v_workspace, v_email);
END
$$;

ALTER FUNCTION reachagent_private.refresh_lead_data_quality(uuid) OWNER TO reachagent_function_owner;

--
-- Public wrapper for refresh_email_group_quality: explicit workspace_id.
--

DROP FUNCTION IF EXISTS public.refresh_email_group_quality(text);

CREATE FUNCTION public.refresh_email_group_quality(p_workspace_id uuid, p_email text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  PERFORM reachagent_private.refresh_email_group_quality(p_workspace_id, NULLIF(pg_catalog.lower(pg_catalog.btrim(p_email)), ''));
END
$$;

ALTER FUNCTION public.refresh_email_group_quality(uuid, text) OWNER TO reachagent_function_owner;

--
-- claim_recipient_outreach(uuid, text): workspace-scoped ownership.
--

CREATE OR REPLACE FUNCTION reachagent_private.claim_recipient_outreach(p_lead_id uuid, p_phase text) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_email TEXT;
  v_workspace UUID;
  v_owner UUID;
  v_bad TEXT;
  v_provisional BOOLEAN := false;
  v_claim_token UUID;
BEGIN
  IF p_phase NOT IN ('initial','follow_up','reactivation') THEN RAISE EXCEPTION 'Invalid outreach phase'; END IF;
  SELECT normalized_email, workspace_id INTO v_email, v_workspace FROM leads WHERE id = p_lead_id FOR UPDATE;
  IF v_email IS NULL THEN
    UPDATE leads SET
      outreach_suppression_reason = 'invalid_email',
      outreach_suppressed_at = COALESCE(outreach_suppressed_at, now()),
      status = CASE WHEN status = 'email_ready' THEN 'researched' ELSE status END,
      updated_at = now()
    WHERE id = p_lead_id;
    UPDATE emails SET status = 'failed'
    WHERE lead_id = p_lead_id AND type = 'initial_pitch' AND status = 'pending_send';
    RETURN jsonb_build_object('allowed', false, 'owner_lead_id', NULL, 'normalized_email', NULL, 'reason', 'invalid_email');
  END IF;

  SELECT issue_type INTO v_bad FROM lead_data_quality_flags
  WHERE workspace_id = v_workspace AND lead_id = p_lead_id AND status = 'open'
    AND issue_type IN ('invalid_email','placeholder_email','technical_email')
  LIMIT 1;
  IF v_bad IS NOT NULL THEN
    UPDATE leads SET
      outreach_suppression_reason = v_bad,
      outreach_suppressed_at = COALESCE(outreach_suppressed_at, now()),
      status = CASE WHEN status = 'email_ready' THEN 'researched' ELSE status END,
      updated_at = now()
    WHERE id = p_lead_id;
    UPDATE emails SET status = 'failed'
    WHERE lead_id = p_lead_id AND type = 'initial_pitch' AND status = 'pending_send';
    RETURN jsonb_build_object('allowed', false, 'owner_lead_id', NULL, 'normalized_email', v_email, 'reason', v_bad);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_workspace::text || ':' || v_email, 734921));
  SELECT owner_lead_id INTO v_owner
  FROM recipient_outreach_ownership
  WHERE workspace_id = v_workspace AND normalized_email = v_email
  FOR UPDATE;
  v_provisional := v_owner IS NULL;
  IF v_owner IS NULL THEN
    SELECT l.id INTO v_owner
    FROM leads l
    JOIN emails e ON e.lead_id = l.id AND e.status IN ('sent','email_sync_failed')
    LEFT JOIN deals d ON d.lead_id = l.id
    WHERE l.workspace_id = v_workspace AND l.normalized_email = v_email
    ORDER BY
      CASE WHEN d.id IS NOT NULL OR l.status IN ('replied','negotiating','interested','closed','closed_manual') THEN 0 ELSE 1 END,
      e.sent_at ASC NULLS LAST, l.created_at ASC, l.id
    LIMIT 1;
  END IF;
  IF v_owner IS NULL THEN v_owner := p_lead_id; END IF;
  IF v_provisional AND v_owner = p_lead_id THEN v_claim_token := gen_random_uuid(); END IF;

  INSERT INTO recipient_outreach_ownership (workspace_id, normalized_email, owner_lead_id, metadata)
  VALUES (
    v_workspace,
    v_email,
    v_owner,
    jsonb_build_object('source', 'claim', 'phase', p_phase)
      || CASE WHEN v_claim_token IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('claim_token', v_claim_token) END
  )
  ON CONFLICT (workspace_id, normalized_email) DO UPDATE SET
    owner_lead_id = COALESCE(recipient_outreach_ownership.owner_lead_id, EXCLUDED.owner_lead_id),
    state = 'active',
    last_activity_at = now(),
    metadata = CASE
      WHEN recipient_outreach_ownership.owner_lead_id IS NULL
        THEN recipient_outreach_ownership.metadata || EXCLUDED.metadata
      ELSE recipient_outreach_ownership.metadata
    END;
  SELECT owner_lead_id INTO v_owner
  FROM recipient_outreach_ownership
  WHERE workspace_id = v_workspace AND normalized_email = v_email;

  INSERT INTO lead_data_quality_flags (workspace_id, lead_id, normalized_email, issue_type, reason, related_lead_ids, metadata)
  SELECT v_workspace, l.id, v_email, 'already_contacted_email',
    'Another lead owns the active outreach lifecycle for this recipient.',
    ARRAY[v_owner], jsonb_build_object('owner_lead_id', v_owner, 'phase', p_phase)
  FROM leads l
  WHERE l.workspace_id = v_workspace AND l.normalized_email = v_email AND l.id <> v_owner
  ON CONFLICT DO NOTHING;

  IF v_owner <> p_lead_id THEN
    UPDATE leads SET
      outreach_suppression_reason = 'email_already_contacted',
      outreach_suppressed_at = COALESCE(outreach_suppressed_at, now()),
      status = CASE WHEN status = 'email_ready' THEN 'researched' ELSE status END,
      updated_at = now()
    WHERE id = p_lead_id;
    UPDATE emails SET status = 'failed'
    WHERE lead_id = p_lead_id AND type = 'initial_pitch' AND status = 'pending_send';
    INSERT INTO lead_data_quality_flags (workspace_id, lead_id, normalized_email, issue_type, reason, related_lead_ids, metadata)
    VALUES (
      v_workspace, p_lead_id, v_email, 'already_contacted_email',
      'Another lead owns the active outreach lifecycle for this recipient.',
      ARRAY[v_owner], jsonb_build_object('owner_lead_id', v_owner, 'phase', p_phase)
    )
    ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('allowed', false, 'owner_lead_id', v_owner, 'normalized_email', v_email, 'reason', 'email_already_contacted');
  END IF;

  UPDATE leads
  SET outreach_suppression_reason = NULL, outreach_suppressed_at = NULL
  WHERE id = p_lead_id AND outreach_suppression_reason = 'email_already_contacted';
  RETURN jsonb_build_object(
    'allowed', true,
    'owner_lead_id', v_owner,
    'normalized_email', v_email,
    'reason', NULL,
    'claim_token', v_claim_token
  );
END
$$;

ALTER FUNCTION reachagent_private.claim_recipient_outreach(uuid, text) OWNER TO reachagent_function_owner;

--
-- release_recipient_outreach_claim(uuid, text, uuid): workspace-scoped.
--

CREATE OR REPLACE FUNCTION reachagent_private.release_recipient_outreach_claim(p_lead_id uuid, p_normalized_email text, p_claim_token uuid) RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_email TEXT := NULLIF(lower(btrim(p_normalized_email)), '');
  v_workspace UUID;
BEGIN
  IF v_email IS NULL THEN RETURN false; END IF;
  SELECT workspace_id INTO v_workspace FROM leads WHERE id = p_lead_id;
  IF v_workspace IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_workspace::text || ':' || v_email, 734921));

  UPDATE recipient_outreach_ownership o
  SET owner_lead_id = NULL,
      state = 'released',
      last_activity_at = now(),
      metadata = o.metadata || jsonb_build_object(
        'released_source', 'generation_persistence_failure',
        'released_lead_id', p_lead_id,
        'released_at', now()
      )
  WHERE o.workspace_id = v_workspace
    AND o.normalized_email = v_email
    AND o.owner_lead_id = p_lead_id
    AND o.metadata->>'claim_token' = p_claim_token::TEXT
    AND NOT EXISTS (
      SELECT 1 FROM emails e
      WHERE e.lead_id = p_lead_id
        AND e.status IN ('pending_send','sent','email_sync_failed')
        AND COALESCE(e.sent_at, e.created_at) >= o.last_activity_at
    )
    AND NOT EXISTS (
      SELECT 1 FROM leads l
      WHERE l.id = p_lead_id
        AND l.status IN ('email_ready','contacted','replied','negotiating','interested','closed','closed_manual')
    );
  RETURN FOUND;
END
$$;

ALTER FUNCTION reachagent_private.release_recipient_outreach_claim(uuid, text, uuid) OWNER TO reachagent_function_owner;

--
-- insert_finder_lead_if_new(uuid, jsonb): explicit workspace_id.
--

CREATE OR REPLACE FUNCTION public.insert_finder_lead_if_new(p_workspace_id uuid, p_lead jsonb)
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
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace_id required';
  END IF;
  IF NULLIF(pg_catalog.btrim(p_lead->>'business_name'), '') IS NULL
     OR NULLIF(pg_catalog.btrim(p_lead->>'city'), '') IS NULL
     OR v_email IS NULL THEN
    RAISE EXCEPTION 'invalid Finder lead candidate';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_workspace_id::text || ':reachagent_finder_insert', 0)
  );

  SELECT leads.* INTO v_match
  FROM public.leads AS leads
  WHERE leads.workspace_id = p_workspace_id
    AND (
      (leads.business_name = pg_catalog.btrim(p_lead->>'business_name') AND leads.city = pg_catalog.btrim(p_lead->>'city'))
      OR (NULLIF(pg_catalog.btrim(p_lead->>'phone'), '') IS NOT NULL AND leads.phone = pg_catalog.btrim(p_lead->>'phone'))
      OR leads.normalized_email = v_email
      OR (v_website_domain IS NOT NULL AND leads.website IS NOT NULL
        AND public.finder_website_domain(leads.website) = v_website_domain)
      OR (NOT v_public_email AND v_email_root IS NOT NULL AND leads.normalized_email IS NOT NULL
        AND public.finder_email_root_domain(leads.normalized_email) = v_email_root)
    )
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
    workspace_id, business_name, category_id, category_name, city, state, phone, email,
    website, address, google_rating, google_reviews_count,
    halal_confidence_score, halal_reasons, status, outreach_channel,
    content_type, source
  ) VALUES (
    p_workspace_id, pg_catalog.btrim(p_lead->>'business_name'), NULLIF(p_lead->>'category_id', '')::uuid,
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
END
$$;

ALTER FUNCTION public.insert_finder_lead_if_new(uuid, jsonb) OWNER TO reachagent_function_owner;

--
-- Natural-key repartitioning.
--

ALTER TABLE public.recipient_outreach_ownership
  DROP CONSTRAINT recipient_outreach_ownership_pkey;
ALTER TABLE public.recipient_outreach_ownership
  ADD PRIMARY KEY (workspace_id, normalized_email);

ALTER TABLE public.exhausted_queries
  DROP CONSTRAINT exhausted_queries_pkey;
ALTER TABLE public.exhausted_queries
  ADD PRIMARY KEY (workspace_id, query);

DROP INDEX IF EXISTS public.categories_name_trimmed_lower_key;
CREATE UNIQUE INDEX categories_name_trimmed_lower_key
  ON public.categories (workspace_id, lower(btrim(name)));

DROP INDEX IF EXISTS public.search_cache_query_idx;
CREATE UNIQUE INDEX search_cache_query_idx
  ON public.search_cache (workspace_id, query);

DROP INDEX IF EXISTS public.emails_lead_type_delivered_key;
CREATE UNIQUE INDEX emails_lead_type_delivered_key
  ON public.emails (workspace_id, lead_id, type)
  WHERE status IN ('sent', 'email_sync_failed');

DROP INDEX IF EXISTS public.emails_one_pending_initial_per_lead_key;
CREATE UNIQUE INDEX emails_one_pending_initial_per_lead_key
  ON public.emails (workspace_id, lead_id)
  WHERE type = 'initial_pitch' AND status = 'pending_send';

DROP INDEX IF EXISTS public.emails_lead_type_open_or_delivered_key;
CREATE UNIQUE INDEX emails_lead_type_open_or_delivered_key
  ON public.emails (workspace_id, lead_id, type)
  WHERE status IN ('pending_send', 'sending', 'sent', 'delivery_uncertain', 'email_sync_failed');

--
-- Grants.
--

REVOKE ALL ON FUNCTION public.refresh_email_group_quality(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_email_group_quality(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.insert_finder_lead_if_new(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_finder_lead_if_new(uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION reachagent_private.refresh_email_group_quality(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reachagent_private.refresh_lead_data_quality(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION reachagent_private.claim_recipient_outreach(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reachagent_private.release_recipient_outreach_claim(uuid, text, uuid) FROM PUBLIC;

REVOKE reachagent_function_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
