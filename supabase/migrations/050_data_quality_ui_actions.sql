-- P2 Data Quality UI actions. Additive, rerunnable, and intentionally does not
-- merge or automatically delete leads.

ALTER TABLE public.lead_data_quality_flags
  ADD COLUMN IF NOT EXISTS resolution_reason TEXT,
  ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lead_data_quality_flags_status_updated_idx
  ON public.lead_data_quality_flags (status, updated_at DESC);

-- A removed email is not an invalid email. Preserve malformed non-null values
-- for review, while allowing the P2 Remove Email action to clear the issue.
CREATE OR REPLACE FUNCTION public.refresh_lead_data_quality(p_lead_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_email TEXT; v_raw_email TEXT; v_type TEXT; v_reason TEXT; v_owner UUID;
BEGIN
  SELECT normalized_email,email INTO v_email,v_raw_email FROM leads WHERE id=p_lead_id;
  DELETE FROM lead_data_quality_flags WHERE lead_id=p_lead_id AND status='open'
    AND issue_type IN ('invalid_email','placeholder_email','technical_email');
  IF v_raw_email IS NOT NULL AND btrim(v_raw_email)<>'' THEN
    SELECT q.issue_type,q.reason INTO v_type,v_reason FROM classify_email_quality(v_raw_email) q LIMIT 1;
    IF v_type IS NOT NULL THEN
      INSERT INTO lead_data_quality_flags(lead_id,normalized_email,issue_type,reason)
      VALUES(p_lead_id,v_email,v_type,v_reason) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  SELECT owner_lead_id INTO v_owner FROM recipient_outreach_ownership
    WHERE normalized_email=v_email AND state='active';
  DELETE FROM lead_data_quality_flags WHERE lead_id=p_lead_id AND status='open'
    AND issue_type='already_contacted_email';
  IF v_owner IS NOT NULL AND v_owner<>p_lead_id THEN
    INSERT INTO lead_data_quality_flags(lead_id,normalized_email,issue_type,reason,related_lead_ids,metadata)
    VALUES(p_lead_id,v_email,'already_contacted_email',
      'Another lead owns the active outreach lifecycle for this recipient.',ARRAY[v_owner],
      jsonb_build_object('owner_lead_id',v_owner)) ON CONFLICT DO NOTHING;
  END IF;
  PERFORM refresh_email_group_quality(v_email);
END;
$$;

-- Resolve/reopen only known P1 issue types. These operations alter review state
-- only; they never mutate a lead or recipient ownership.
CREATE OR REPLACE FUNCTION public.set_data_quality_flag_status(
  p_issue_type TEXT,
  p_normalized_email TEXT DEFAULT NULL,
  p_lead_ids UUID[] DEFAULT NULL,
  p_status TEXT DEFAULT 'resolved',
  p_resolution_reason TEXT DEFAULT NULL,
  p_actor_id UUID DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ids UUID[]; v_count INTEGER;
BEGIN
  IF p_issue_type NOT IN ('duplicate_lead','shared_email','uncertain_email_group','invalid_email',
    'placeholder_email','technical_email','already_contacted_email') THEN
    RAISE EXCEPTION 'Unsupported data-quality issue type';
  END IF;
  IF p_status NOT IN ('resolved','open') THEN RAISE EXCEPTION 'Unsupported flag transition'; END IF;
  IF p_issue_type IN ('duplicate_lead','shared_email','uncertain_email_group')
     AND NULLIF(btrim(p_normalized_email),'') IS NULL THEN
    RAISE EXCEPTION 'A recipient email is required for grouped issues';
  END IF;
  IF p_issue_type NOT IN ('duplicate_lead','shared_email','uncertain_email_group')
     AND COALESCE(cardinality(p_lead_ids),0)=0 THEN
    RAISE EXCEPTION 'At least one lead is required';
  END IF;

  IF p_status='resolved' THEN
    WITH changed AS (
      UPDATE lead_data_quality_flags SET status='resolved', resolved_at=now(), updated_at=now(),
        resolution_reason=NULLIF(btrim(p_resolution_reason),''), resolved_by=p_actor_id
      WHERE issue_type=p_issue_type AND status='open'
        AND (p_normalized_email IS NULL OR normalized_email=p_normalized_email)
        AND (p_lead_ids IS NULL OR lead_id=ANY(p_lead_ids))
      RETURNING lead_id
    ) SELECT COALESCE(array_agg(DISTINCT lead_id),'{}'::UUID[]) INTO v_ids FROM changed;
  ELSE
    WITH candidates AS (
      SELECT DISTINCT ON (lead_id,issue_type,COALESCE(normalized_email,'')) id,lead_id
      FROM lead_data_quality_flags f
      WHERE issue_type=p_issue_type AND status='resolved'
        AND (p_normalized_email IS NULL OR normalized_email=p_normalized_email)
        AND (p_lead_ids IS NULL OR lead_id=ANY(p_lead_ids))
        AND NOT EXISTS (
          SELECT 1 FROM lead_data_quality_flags o WHERE o.status='open' AND o.lead_id=f.lead_id
            AND o.issue_type=f.issue_type AND COALESCE(o.normalized_email,'')=COALESCE(f.normalized_email,'')
        )
      ORDER BY lead_id,issue_type,COALESCE(normalized_email,''),resolved_at DESC NULLS LAST
    ), changed AS (
      UPDATE lead_data_quality_flags f SET status='open',resolved_at=NULL,updated_at=now(),
        resolution_reason=NULL,resolved_by=NULL FROM candidates c WHERE f.id=c.id RETURNING f.lead_id
    ) SELECT COALESCE(array_agg(DISTINCT lead_id),'{}'::UUID[]) INTO v_ids FROM changed;
  END IF;
  v_count:=cardinality(v_ids);
  IF v_count=0 THEN RAISE EXCEPTION 'No matching flags were available for this transition'; END IF;

  INSERT INTO activity_log(event_type,lead_id,description,metadata)
  SELECT CASE WHEN p_status='resolved' THEN 'data_quality_flag_resolved' ELSE 'data_quality_flag_reopened' END,
    id,CASE WHEN p_status='resolved' THEN 'Data Quality flag resolved by an admin.'
      ELSE 'Data Quality flag reopened by an admin.' END,
    jsonb_strip_nulls(jsonb_build_object('issue_type',p_issue_type,'normalized_email',p_normalized_email,
      'actor_id',p_actor_id,'resolution_reason',NULLIF(btrim(p_resolution_reason),'')))
  FROM unnest(v_ids) id;
  RETURN jsonb_build_object('updated',v_count,'lead_ids',v_ids,'status',p_status);
END;
$$;

-- Removes only currently flagged junk addresses. The whole statement fails if
-- any target is protected or owns recipient outreach, so bulk actions cannot
-- silently skip safeguards or partially succeed.
CREATE OR REPLACE FUNCTION public.remove_data_quality_emails(
  p_lead_ids UUID[], p_actor_id UUID DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ids UUID[]; v_requested INTEGER; v_found INTEGER; v_blocked RECORD;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT id),'{}'::UUID[]) INTO v_ids FROM unnest(p_lead_ids) id;
  v_requested:=cardinality(v_ids);
  IF v_requested<1 OR v_requested>100 THEN RAISE EXCEPTION 'Select between 1 and 100 leads'; END IF;

  PERFORM 1 FROM leads WHERE id=ANY(v_ids) FOR UPDATE;
  SELECT COUNT(*) INTO v_found FROM leads WHERE id=ANY(v_ids);
  IF v_found<>v_requested THEN RAISE EXCEPTION 'One or more selected leads no longer exist'; END IF;
  IF EXISTS (
    SELECT 1 FROM leads l WHERE l.id=ANY(v_ids) AND NOT EXISTS (
      SELECT 1 FROM lead_data_quality_flags f WHERE f.lead_id=l.id AND f.status='open'
        AND f.issue_type IN ('invalid_email','placeholder_email','technical_email')
    )
  ) THEN RAISE EXCEPTION 'Every selected lead must have an open invalid, placeholder, or technical email flag'; END IF;

  SELECT l.id,l.business_name INTO v_blocked FROM leads l
  WHERE l.id=ANY(v_ids) AND (
    l.status IN ('replied','negotiating','interested','closed','closed_won','closed_manual')
    OR NULLIF(btrim(l.notes),'') IS NOT NULL
    OR EXISTS (SELECT 1 FROM emails e WHERE e.lead_id=l.id)
    OR EXISTS (SELECT 1 FROM deals d WHERE d.lead_id=l.id)
  ) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'Email removal blocked: lead % is protected by lifecycle or history',v_blocked.id; END IF;

  SELECT l.id,l.business_name INTO v_blocked FROM leads l JOIN recipient_outreach_ownership o
    ON o.owner_lead_id=l.id AND o.normalized_email=l.normalized_email AND o.state='active'
  WHERE l.id=ANY(v_ids) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'Email removal blocked: lead % owns the active recipient outreach lifecycle',v_blocked.id; END IF;

  WITH originals AS (
    SELECT l.id,l.normalized_email,
      (SELECT f.issue_type FROM lead_data_quality_flags f WHERE f.lead_id=l.id AND f.status='open'
        AND f.issue_type IN ('invalid_email','placeholder_email','technical_email') ORDER BY f.created_at LIMIT 1) issue_type
    FROM leads l WHERE l.id=ANY(v_ids)
  ), changed AS (
    UPDATE leads l SET email=NULL,updated_at=now() FROM originals o WHERE l.id=o.id
    RETURNING l.id,o.normalized_email,o.issue_type
  )
  INSERT INTO activity_log(event_type,lead_id,description,metadata)
  SELECT 'data_quality_email_removed',id,'Invalid or junk email removed by an admin.',
    jsonb_strip_nulls(jsonb_build_object('issue_type',issue_type,'normalized_email',normalized_email,'actor_id',p_actor_id))
  FROM changed;

  RETURN jsonb_build_object('updated',v_requested,'lead_ids',v_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.set_data_quality_flag_status(TEXT,TEXT,UUID[],TEXT,TEXT,UUID) FROM PUBLIC,authenticated;
REVOKE ALL ON FUNCTION public.remove_data_quality_emails(UUID[],UUID) FROM PUBLIC,authenticated;
GRANT EXECUTE ON FUNCTION public.set_data_quality_flag_status(TEXT,TEXT,UUID[],TEXT,TEXT,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_data_quality_emails(UUID[],UUID) TO service_role;

-- Existing P1 rows created for truly empty emails are closed once; future null
-- emails are ignored by refresh_lead_data_quality above.
UPDATE public.lead_data_quality_flags f SET status='resolved',resolved_at=COALESCE(resolved_at,now()),
  updated_at=now(),resolution_reason=COALESCE(resolution_reason,'Email is already empty.')
FROM public.leads l WHERE f.lead_id=l.id AND f.status='open' AND f.issue_type='invalid_email'
  AND (l.email IS NULL OR btrim(l.email)='');

-- P1's summary classified directly from leads, so resolved groups would remain
-- counted. P2 treats open persisted flags as the review queue source of truth.
CREATE OR REPLACE FUNCTION public.get_data_quality_summary()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH open_flags AS (
  SELECT * FROM lead_data_quality_flags WHERE status='open'
), protected_duplicates AS (
  SELECT DISTINCT l.id FROM leads l JOIN open_flags f ON f.lead_id=l.id AND f.issue_type='duplicate_lead'
  WHERE l.status IN ('replied','negotiating','interested','closed','closed_won','closed_manual')
    OR NULLIF(btrim(l.notes),'') IS NOT NULL
    OR EXISTS (SELECT 1 FROM emails e WHERE e.lead_id=l.id)
    OR EXISTS (SELECT 1 FROM deals d WHERE d.lead_id=l.id)
), duplicate_totals AS (
  SELECT COUNT(DISTINCT lead_id)::INT members,COUNT(DISTINCT normalized_email)::INT groups
  FROM open_flags WHERE issue_type='duplicate_lead'
)
SELECT jsonb_build_object(
  'duplicate_lead_groups',COUNT(DISTINCT normalized_email) FILTER(WHERE issue_type='duplicate_lead'),
  'shared_email_groups',COUNT(DISTINCT normalized_email) FILTER(WHERE issue_type='shared_email'),
  'uncertain_email_groups',COUNT(DISTINCT normalized_email) FILTER(WHERE issue_type='uncertain_email_group'),
  'placeholder_emails',COUNT(*) FILTER(WHERE issue_type='placeholder_email'),
  'technical_emails',COUNT(*) FILTER(WHERE issue_type='technical_email'),
  'invalid_emails',COUNT(*) FILTER(WHERE issue_type='invalid_email'),
  'already_contacted_email_leads',COUNT(*) FILTER(WHERE issue_type='already_contacted_email'),
  'protected_duplicate_records',(SELECT COUNT(*) FROM protected_duplicates),
  'safe_looking_duplicate_candidates',GREATEST(
    (SELECT members-groups FROM duplicate_totals)-(SELECT COUNT(*) FROM protected_duplicates),0)
) FROM open_flags;
$$;

GRANT EXECUTE ON FUNCTION public.get_data_quality_summary() TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_data_quality_report_v2(
  p_issue_type TEXT DEFAULT NULL, p_search TEXT DEFAULT NULL, p_email TEXT DEFAULT NULL,
  p_business TEXT DEFAULT NULL, p_category TEXT DEFAULT NULL, p_city TEXT DEFAULT NULL,
  p_page INTEGER DEFAULT 1, p_page_size INTEGER DEFAULT 50
) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH lead_facts AS (
  SELECT l.*,
    regexp_replace(lower(COALESCE(l.business_name,'')), '[^a-z0-9]+', '', 'g') norm_name,
    regexp_replace(lower(COALESCE(l.phone,'')), '[^0-9]+', '', 'g') norm_phone,
    regexp_replace(lower(COALESCE(l.instagram_handle,'')), '[^a-z0-9]+', '', 'g') norm_social,
    regexp_replace(lower(COALESCE(l.address,'')||COALESCE(l.suburb,'')), '[^a-z0-9]+', '', 'g') norm_address,
    regexp_replace(lower(COALESCE(l.website,'')), '^https?://(www\.)?|/.*$', '', 'g') norm_domain,
    COUNT(DISTINCT e.id) FILTER(WHERE e.status IN ('sent','email_sync_failed'))::INT outreach_count,
    COUNT(DISTINCT e.id)::INT all_email_count,
    MAX(COALESCE(e.sent_at,e.created_at)) FILTER(WHERE e.status IN ('sent','email_sync_failed')) latest_outreach_at,
    bool_or(e.replied_at IS NOT NULL) email_has_reply,bool_or(d.id IS NOT NULL) has_deal
  FROM leads l LEFT JOIN emails e ON e.lead_id=l.id LEFT JOIN deals d ON d.lead_id=l.id GROUP BY l.id
), groups AS (
  SELECT normalized_email,COUNT(*)::INT lead_count,array_agg(id ORDER BY created_at) lead_ids,
    array_agg(business_name ORDER BY created_at) business_names,array_agg(status ORDER BY created_at) statuses,
    SUM(outreach_count)::INT outreach_count,MAX(latest_outreach_at) latest_outreach_at,
    bool_or(email_has_reply OR status IN ('replied','negotiating','interested')) has_reply,
    bool_or(has_deal OR status IN ('closed','closed_won','closed_manual')) has_deal,
    bool_or(NULLIF(btrim(notes),'') IS NOT NULL) has_notes,bool_or(all_email_count>0) has_email_history,
    COUNT(DISTINCT NULLIF(norm_name,'')) name_count,COUNT(DISTINCT NULLIF(norm_domain,'')) domain_count,
    COUNT(DISTINCT NULLIF(norm_phone,'')) phone_count,COUNT(DISTINCT NULLIF(norm_social,'')) social_count,
    COUNT(DISTINCT NULLIF(norm_address,'')) address_count,
    (array_agg(id ORDER BY
      (email_has_reply OR has_deal OR status IN ('replied','negotiating','interested','closed','closed_won','closed_manual')) DESC,
      CASE status WHEN 'closed_won' THEN 70 WHEN 'closed' THEN 65 WHEN 'closed_manual' THEN 65 WHEN 'negotiating' THEN 60
        WHEN 'interested' THEN 55 WHEN 'replied' THEN 50 WHEN 'contacted' THEN 30 WHEN 'email_ready' THEN 20 WHEN 'researched' THEN 10 ELSE 0 END DESC,
      outreach_count DESC,num_nonnulls(business_name,website,phone,address,suburb,instagram_handle) DESC,created_at,id))[1] preferred_lead_id,
    array_agg(DISTINCT category_name) categories,array_agg(DISTINCT city) cities,array_agg(DISTINCT norm_domain) domains
  FROM lead_facts WHERE normalized_email IS NOT NULL GROUP BY normalized_email HAVING COUNT(*)>1
), group_issues AS (
  SELECT *,CASE WHEN name_count=1 OR (domain_count=1 AND phone_count=1) OR (domain_count=1 AND social_count=1) THEN 'duplicate_lead'
    WHEN name_count=lead_count AND (address_count=0 OR address_count>1) THEN 'shared_email' ELSE 'uncertain_email_group' END issue_type,
    CASE WHEN name_count=1 THEN ARRAY['same_normalized_email','same_normalized_business_name']
      WHEN domain_count=1 AND phone_count=1 THEN ARRAY['same_normalized_email','same_website_domain','same_phone']
      WHEN domain_count=1 AND social_count=1 THEN ARRAY['same_normalized_email','same_website_domain','same_social_handle']
      WHEN name_count=lead_count AND address_count>1 THEN ARRAY['same_normalized_email','different_business_names','different_addresses']
      WHEN name_count=lead_count THEN ARRAY['same_normalized_email','different_business_names']
      ELSE ARRAY['same_normalized_email','insufficient_deterministic_signals'] END reasons
  FROM groups
), open_groups AS (
  SELECT g.* FROM group_issues g WHERE EXISTS (
    SELECT 1 FROM lead_data_quality_flags f WHERE f.status='open' AND f.normalized_email=g.normalized_email
      AND f.issue_type=g.issue_type
  )
), flag_issues AS (
  SELECT f.normalized_email,f.issue_type,1::INT lead_count,ARRAY[l.id] lead_ids,ARRAY[l.business_name] business_names,
    ARRAY[l.status] statuses,l.outreach_count,l.latest_outreach_at,
    (l.status IN ('replied','negotiating','interested') OR l.email_has_reply) has_reply,
    (l.has_deal OR l.status IN ('closed','closed_won','closed_manual')) has_deal,
    NULLIF(btrim(l.notes),'') IS NOT NULL has_notes,l.all_email_count>0 has_email_history,l.id preferred_lead_id,
    ARRAY[l.category_name] categories,ARRAY[l.city] cities,ARRAY[l.norm_domain] domains,ARRAY[f.reason] reasons
  FROM lead_data_quality_flags f JOIN lead_facts l ON l.id=f.lead_id WHERE f.status='open'
    AND f.issue_type IN ('invalid_email','placeholder_email','technical_email','already_contacted_email')
), issues AS (
  SELECT normalized_email,issue_type,lead_count,lead_ids,business_names,statuses,outreach_count,latest_outreach_at,
    has_reply,has_deal,has_notes,has_email_history,false has_booking,
    (has_reply OR has_deal OR has_notes OR has_email_history) protected_from_auto_delete,
    preferred_lead_id,array_remove(lead_ids,preferred_lead_id) suggested_redundant_lead_ids,categories,cities,domains,reasons
  FROM open_groups UNION ALL
  SELECT normalized_email,issue_type,lead_count,lead_ids,business_names,statuses,outreach_count,latest_outreach_at,
    has_reply,has_deal,has_notes,has_email_history,false,(has_reply OR has_deal OR has_notes OR has_email_history),
    preferred_lead_id,ARRAY[]::UUID[],categories,cities,domains,reasons FROM flag_issues
), filtered AS (
  SELECT * FROM issues WHERE (p_issue_type IS NULL OR issue_type=p_issue_type)
    AND (p_search IS NULL OR normalized_email ILIKE '%'||btrim(p_search)||'%'
      OR array_to_string(business_names,' ') ILIKE '%'||btrim(p_search)||'%'
      OR array_to_string(domains,' ') ILIKE '%'||btrim(p_search)||'%')
    AND (p_email IS NULL OR normalized_email ILIKE '%'||lower(btrim(p_email))||'%')
    AND (p_business IS NULL OR array_to_string(business_names,' ') ILIKE '%'||btrim(p_business)||'%')
    AND (p_category IS NULL OR EXISTS (SELECT 1 FROM unnest(categories) value WHERE value ILIKE btrim(p_category)))
    AND (p_city IS NULL OR EXISTS (SELECT 1 FROM unnest(cities) value WHERE value ILIKE btrim(p_city)))
), paged AS (
  SELECT * FROM filtered ORDER BY latest_outreach_at DESC NULLS LAST,normalized_email,issue_type
  LIMIT LEAST(GREATEST(p_page_size,1),100) OFFSET (GREATEST(p_page,1)-1)*LEAST(GREATEST(p_page_size,1),100)
)
SELECT jsonb_build_object('data',COALESCE(jsonb_agg(to_jsonb(paged)),'[]'::jsonb),
  'total',(SELECT COUNT(*) FROM filtered),'page',GREATEST(p_page,1),
  'page_size',LEAST(GREATEST(p_page_size,1),100)) FROM paged;
$$;

GRANT EXECUTE ON FUNCTION public.get_data_quality_report_v2(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,INTEGER)
  TO authenticated,service_role;
