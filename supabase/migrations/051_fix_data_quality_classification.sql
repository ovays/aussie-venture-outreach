-- Conservative Data Quality group classification. This migration intentionally
-- does not alter recipient outreach ownership, merge leads, or delete leads.

CREATE OR REPLACE FUNCTION public.data_quality_present(p_value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN NULLIF(btrim(p_value),'') IS NULL THEN NULL
    WHEN lower(btrim(p_value)) = ANY (ARRAY[
      'not found','not mentioned','not available','unknown','n/a','-'
    ]) THEN NULL
    ELSE btrim(p_value)
  END
$$;

CREATE OR REPLACE FUNCTION public.data_quality_compact_identity(p_value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT NULLIF(regexp_replace(lower(public.data_quality_present(p_value)),'[^a-z0-9]+','','g'),'')
$$;

CREATE OR REPLACE FUNCTION public.data_quality_phone_identity(p_value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT NULLIF(regexp_replace(public.data_quality_present(p_value),'[^0-9]+','','g'),'')
$$;

CREATE OR REPLACE FUNCTION public.data_quality_website_identity(p_value TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE v_value TEXT := lower(public.data_quality_present(p_value));
BEGIN
  IF v_value IS NULL THEN RETURN NULL; END IF;
  v_value := regexp_replace(v_value,'^[a-z][a-z0-9+.-]*://','','i');
  v_value := regexp_replace(v_value,'^www\.','','i');
  v_value := regexp_replace(v_value,'[?#].*$','');
  v_value := regexp_replace(v_value,'/{2,}','/','g');
  v_value := regexp_replace(v_value,'/+$','');
  RETURN NULLIF(v_value,'');
END;
$$;

CREATE OR REPLACE FUNCTION public.data_quality_meaningful_website_identity(p_value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN position('/' IN public.data_quality_website_identity(p_value)) > 0
    THEN public.data_quality_website_identity(p_value) ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION public.data_quality_social_identity(p_value TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE v_value TEXT := lower(public.data_quality_present(p_value));
BEGIN
  IF v_value IS NULL THEN RETURN NULL; END IF;
  v_value := regexp_replace(v_value,'^[a-z][a-z0-9+.-]*://','','i');
  v_value := regexp_replace(v_value,'^www\.','','i');
  v_value := regexp_replace(v_value,'^(instagram\.com/)?@?','','i');
  v_value := regexp_replace(v_value,'[/?#].*$','');
  v_value := regexp_replace(v_value,'[^a-z0-9._]+','','g');
  RETURN NULLIF(v_value,'');
END;
$$;

-- The JSON form gives refresh/report SQL one canonical classifier. A match is
-- valid only when the value is populated on every lead in the email group.
CREATE OR REPLACE FUNCTION public.classify_data_quality_group(p_leads JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
WITH facts AS (
  SELECT
    public.data_quality_compact_identity(value->>'business_name') AS norm_name,
    public.data_quality_meaningful_website_identity(value->>'website') AS norm_website,
    public.data_quality_phone_identity(value->>'phone') AS norm_phone,
    public.data_quality_social_identity(value->>'instagram_handle') AS norm_social,
    CASE WHEN public.data_quality_present(value->>'address') IS NULL THEN NULL
      ELSE public.data_quality_compact_identity(
        public.data_quality_present(value->>'address') ||
        COALESCE(public.data_quality_present(value->>'suburb'),'')
      ) END AS norm_address
  FROM jsonb_array_elements(COALESCE(p_leads,'[]'::jsonb)) value
), stats AS (
  SELECT COUNT(*)::INT AS lead_count,
    COUNT(norm_name)::INT AS name_present,COUNT(DISTINCT norm_name)::INT AS name_count,
    COUNT(norm_website)::INT AS website_present,COUNT(DISTINCT norm_website)::INT AS website_count,
    COUNT(norm_phone)::INT AS phone_present,COUNT(DISTINCT norm_phone)::INT AS phone_count,
    COUNT(norm_social)::INT AS social_present,COUNT(DISTINCT norm_social)::INT AS social_count,
    COUNT(norm_address)::INT AS address_present,COUNT(DISTINCT norm_address)::INT AS address_count
  FROM facts
), signals AS (
  SELECT *,
    name_present=lead_count AND name_count=1 AS same_name,
    website_present=lead_count AND website_count=1 AS same_website,
    phone_present=lead_count AND phone_count=1 AS same_phone,
    social_present=lead_count AND social_count=1 AS same_social,
    address_present=lead_count AND address_count=1 AS same_address
  FROM stats
), classified AS (
  SELECT *,CASE
    WHEN lead_count < 2 THEN 'uncertain_email_group'
    WHEN same_name AND (same_website OR same_phone OR same_social OR same_address) THEN 'duplicate_lead'
    WHEN name_present=lead_count AND name_count>1 THEN 'shared_email'
    ELSE 'uncertain_email_group'
  END AS issue_type FROM signals
)
SELECT jsonb_build_object(
  'issue_type',issue_type,
  'reasons',CASE
    WHEN issue_type='duplicate_lead' THEN
      ARRAY['same_normalized_email','same_normalized_business_name']::TEXT[]
      || CASE WHEN same_website THEN ARRAY['same_meaningful_website_path'] ELSE ARRAY[]::TEXT[] END
      || CASE WHEN same_phone THEN ARRAY['same_phone'] ELSE ARRAY[]::TEXT[] END
      || CASE WHEN same_social THEN ARRAY['same_social_handle'] ELSE ARRAY[]::TEXT[] END
      || CASE WHEN same_address THEN ARRAY['same_address'] ELSE ARRAY[]::TEXT[] END
    WHEN issue_type='shared_email' THEN
      ARRAY['same_normalized_email','different_business_names']::TEXT[]
      || CASE WHEN same_address THEN ARRAY['same_address'] ELSE ARRAY[]::TEXT[] END
    ELSE ARRAY['same_normalized_email','insufficient_or_conflicting_identity_evidence']::TEXT[]
  END
) FROM classified
$$;

CREATE OR REPLACE FUNCTION public.refresh_email_group_quality(p_email TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INT; v_type TEXT; v_reasons TEXT[]; v_ids UUID[]; v_leads JSONB; v_result JSONB;
BEGIN
  IF p_email IS NULL THEN RETURN; END IF;
  DELETE FROM lead_data_quality_flags WHERE normalized_email=p_email AND status='open'
    AND issue_type IN ('duplicate_lead','shared_email','uncertain_email_group');
  SELECT COUNT(*)::INT,array_agg(id ORDER BY created_at),
    jsonb_agg(jsonb_build_object('business_name',business_name,'website',website,'phone',phone,
      'address',address,'suburb',suburb,'instagram_handle',instagram_handle) ORDER BY created_at,id)
  INTO v_count,v_ids,v_leads FROM leads WHERE normalized_email=p_email;
  IF v_count < 2 THEN RETURN; END IF;
  v_result:=public.classify_data_quality_group(v_leads);
  v_type:=v_result->>'issue_type';
  SELECT array_agg(value) INTO v_reasons FROM jsonb_array_elements_text(v_result->'reasons') value;
  INSERT INTO lead_data_quality_flags(lead_id,normalized_email,issue_type,reason,related_lead_ids,metadata)
  SELECT id,p_email,v_type,array_to_string(v_reasons,', '),array_remove(v_ids,id),jsonb_build_object('signals',v_reasons)
  FROM leads WHERE normalized_email=p_email ON CONFLICT DO NOTHING;
END;
$$;

-- Preserve migration 050's empty-email and ownership-flag behaviour verbatim;
-- only the group classifier called at the end is replaced above.
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

CREATE OR REPLACE FUNCTION public.trigger_refresh_lead_data_quality()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.normalized_email IS DISTINCT FROM NEW.normalized_email THEN
    PERFORM refresh_email_group_quality(OLD.normalized_email);
  END IF;
  PERFORM refresh_lead_data_quality(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_refresh_data_quality ON public.leads;
CREATE TRIGGER leads_refresh_data_quality
  AFTER INSERT OR UPDATE OF email,business_name,website,phone,address,suburb,instagram_handle ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.trigger_refresh_lead_data_quality();

-- Reclassify existing open groups only when this migration is deliberately
-- applied. This block is not run by creating or reviewing the migration file.
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT DISTINCT normalized_email FROM public.leads WHERE normalized_email IS NOT NULL
  LOOP PERFORM public.refresh_email_group_quality(r.normalized_email); END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.get_data_quality_report_v2(
  p_issue_type TEXT DEFAULT NULL, p_search TEXT DEFAULT NULL, p_email TEXT DEFAULT NULL,
  p_business TEXT DEFAULT NULL, p_category TEXT DEFAULT NULL, p_city TEXT DEFAULT NULL,
  p_page INTEGER DEFAULT 1, p_page_size INTEGER DEFAULT 50
) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH lead_facts AS (
  SELECT l.*,
    public.data_quality_compact_identity(l.business_name) norm_name,
    public.data_quality_phone_identity(l.phone) norm_phone,
    public.data_quality_social_identity(l.instagram_handle) norm_social,
    CASE WHEN public.data_quality_present(l.address) IS NULL THEN NULL ELSE
      public.data_quality_compact_identity(public.data_quality_present(l.address)||COALESCE(public.data_quality_present(l.suburb),'')) END norm_address,
    public.data_quality_website_identity(l.website) norm_domain,
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
    (array_agg(id ORDER BY
      (email_has_reply OR has_deal OR status IN ('replied','negotiating','interested','closed','closed_won','closed_manual')) DESC,
      CASE status WHEN 'closed_won' THEN 70 WHEN 'closed' THEN 65 WHEN 'closed_manual' THEN 65 WHEN 'negotiating' THEN 60
        WHEN 'interested' THEN 55 WHEN 'replied' THEN 50 WHEN 'contacted' THEN 30 WHEN 'email_ready' THEN 20 WHEN 'researched' THEN 10 ELSE 0 END DESC,
      outreach_count DESC,num_nonnulls(business_name,website,phone,address,suburb,instagram_handle) DESC,created_at,id))[1] preferred_lead_id,
    array_agg(DISTINCT category_name) categories,array_agg(DISTINCT city) cities,array_agg(DISTINCT norm_domain) domains,
    jsonb_agg(jsonb_build_object('business_name',business_name,'website',website,'phone',phone,
      'address',address,'suburb',suburb,'instagram_handle',instagram_handle) ORDER BY created_at,id) classification_input
  FROM lead_facts WHERE normalized_email IS NOT NULL GROUP BY normalized_email HAVING COUNT(*)>1
), group_issues AS (
  SELECT g.*,(classification.result->>'issue_type') issue_type,
    ARRAY(SELECT jsonb_array_elements_text(classification.result->'reasons')) reasons
  FROM groups g CROSS JOIN LATERAL
    (SELECT public.classify_data_quality_group(g.classification_input) result) classification
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

GRANT EXECUTE ON FUNCTION public.data_quality_present(TEXT) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.data_quality_compact_identity(TEXT) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.data_quality_phone_identity(TEXT) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.data_quality_website_identity(TEXT) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.data_quality_meaningful_website_identity(TEXT) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.data_quality_social_identity(TEXT) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.classify_data_quality_group(JSONB) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_data_quality_report_v2(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,INTEGER)
  TO authenticated,service_role;
