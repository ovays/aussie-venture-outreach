-- P1 data quality: canonical recipient identity, conservative flags, reporting,
-- and one active outreach lifecycle per normalized email address.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS normalized_email TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS outreach_suppression_reason TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS outreach_suppressed_at TIMESTAMPTZ;

UPDATE leads SET normalized_email = NULLIF(lower(btrim(email)), '');

CREATE INDEX IF NOT EXISTS leads_normalized_email_idx
  ON leads (normalized_email) WHERE normalized_email IS NOT NULL;

CREATE OR REPLACE FUNCTION set_lead_normalized_email()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.normalized_email := NULLIF(lower(btrim(NEW.email)), '');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_set_normalized_email ON leads;
CREATE TRIGGER leads_set_normalized_email
  BEFORE INSERT OR UPDATE OF email ON leads
  FOR EACH ROW EXECUTE FUNCTION set_lead_normalized_email();

CREATE TABLE IF NOT EXISTS lead_data_quality_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  normalized_email TEXT,
  issue_type TEXT NOT NULL CHECK (issue_type IN (
    'duplicate_lead', 'shared_email', 'uncertain_email_group', 'invalid_email',
    'placeholder_email', 'technical_email', 'already_contacted_email'
  )),
  reason TEXT NOT NULL,
  related_lead_ids UUID[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_data_quality_flags_open_key
  ON lead_data_quality_flags (lead_id, issue_type, COALESCE(normalized_email, ''))
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS lead_data_quality_flags_email_idx
  ON lead_data_quality_flags (normalized_email, issue_type) WHERE status = 'open';

ALTER TABLE lead_data_quality_flags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read data quality flags" ON lead_data_quality_flags;
CREATE POLICY "Authenticated users can read data quality flags" ON lead_data_quality_flags
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Service role manages data quality flags" ON lead_data_quality_flags;
CREATE POLICY "Service role manages data quality flags" ON lead_data_quality_flags
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS recipient_outreach_ownership (
  normalized_email TEXT PRIMARY KEY,
  owner_lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'released')),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS recipient_outreach_owner_lead_idx
  ON recipient_outreach_ownership (owner_lead_id) WHERE owner_lead_id IS NOT NULL;
ALTER TABLE recipient_outreach_ownership ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read recipient ownership" ON recipient_outreach_ownership;
CREATE POLICY "Authenticated users can read recipient ownership" ON recipient_outreach_ownership
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Service role manages recipient ownership" ON recipient_outreach_ownership;
CREATE POLICY "Service role manages recipient ownership" ON recipient_outreach_ownership
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION classify_email_quality(p_email TEXT)
RETURNS TABLE(issue_type TEXT, reason TEXT)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_email TEXT := NULLIF(lower(btrim(p_email)), '');
  v_local TEXT;
  v_domain TEXT;
BEGIN
  IF v_email IS NULL OR v_email !~ '^[^[:space:]@<>(),;:\\"\[\]]+@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' THEN
    RETURN QUERY SELECT 'invalid_email'::TEXT, 'Email is empty or malformed.'::TEXT;
    RETURN;
  END IF;
  v_local := split_part(v_email, '@', 1);
  v_domain := split_part(v_email, '@', 2);
  IF v_email = ANY (ARRAY['user@domain.com','john@doe.com','test@example.com','example@example.com','user@example.com','email@example.com','name@example.com','yourname@example.com','test@test.com'])
     OR v_domain = ANY (ARRAY['example.com','example.org','example.net']) THEN
    RETURN QUERY SELECT 'placeholder_email'::TEXT, 'Address uses a standard example, test, or placeholder mailbox.'::TEXT;
    RETURN;
  END IF;
  IF (v_domain ~ '(^|\.)ingest(\.[a-z0-9-]+)?\.sentry\.io$' OR v_domain ~ '(^|\.)sentry\.io$' OR v_domain ~ '(^|\.)sentry\.wixpress\.com$' OR v_domain ~ '(^|\.)errors\.wix\.com$')
     AND v_local ~ '^([a-f0-9]{24,}|sentry([-_.].*)?|errors?([-_.].*)?|[a-z0-9_-]+\+[a-f0-9]{16,})$' THEN
    RETURN QUERY SELECT 'technical_email'::TEXT, 'Address is a provider-generated error-reporting or ingestion mailbox.'::TEXT;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION refresh_lead_data_quality(p_lead_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email TEXT;
  v_type TEXT;
  v_reason TEXT;
BEGIN
  SELECT normalized_email INTO v_email FROM leads WHERE id = p_lead_id;
  DELETE FROM lead_data_quality_flags
   WHERE lead_id = p_lead_id AND status = 'open'
     AND issue_type IN ('invalid_email','placeholder_email','technical_email');
  SELECT q.issue_type, q.reason INTO v_type, v_reason
    FROM classify_email_quality((SELECT email FROM leads WHERE id = p_lead_id)) q LIMIT 1;
  IF v_type IS NOT NULL THEN
    INSERT INTO lead_data_quality_flags (lead_id, normalized_email, issue_type, reason)
    VALUES (p_lead_id, v_email, v_type, v_reason)
    ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION trigger_refresh_lead_data_quality()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM refresh_lead_data_quality(NEW.id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS leads_refresh_data_quality ON leads;
CREATE TRIGGER leads_refresh_data_quality
  AFTER INSERT OR UPDATE OF email ON leads
  FOR EACH ROW EXECUTE FUNCTION trigger_refresh_lead_data_quality();

DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT id FROM leads LOOP PERFORM refresh_lead_data_quality(r.id); END LOOP;
END $$;

-- Establish an owner for every recipient with delivered history. Protected
-- lifecycle states/deals win; earliest real send is the deterministic tie-breaker.
WITH ownership_candidates AS (
  SELECT
    l.normalized_email,
    l.id AS lead_id,
    l.status,
    l.created_at AS lead_created_at,
    EXISTS (SELECT 1 FROM deals d WHERE d.lead_id = l.id) AS has_deal,
    MIN(COALESCE(e.sent_at, e.created_at)) AS earliest_outreach_at,
    MAX(COALESCE(e.sent_at, e.created_at)) AS latest_outreach_at
  FROM leads l
  JOIN emails e ON e.lead_id = l.id AND e.status IN ('sent','email_sync_failed')
  WHERE l.normalized_email IS NOT NULL
  GROUP BY l.normalized_email, l.id, l.status, l.created_at
), selected_owners AS (
  SELECT DISTINCT ON (normalized_email)
    normalized_email,
    lead_id,
    COALESCE(earliest_outreach_at, lead_created_at, now()) AS claimed_at,
    COALESCE(latest_outreach_at, lead_created_at, now()) AS last_activity_at
  FROM ownership_candidates
  ORDER BY normalized_email,
    CASE WHEN has_deal OR status IN ('replied','negotiating','interested','closed_won','closed','closed_manual') THEN 0 ELSE 1 END,
    COALESCE(earliest_outreach_at, lead_created_at) ASC NULLS LAST,
    lead_created_at ASC NULLS LAST,
    lead_id
)
INSERT INTO recipient_outreach_ownership (normalized_email, owner_lead_id, claimed_at, last_activity_at, metadata)
SELECT
  normalized_email, lead_id, claimed_at, last_activity_at,
  jsonb_build_object('source', 'migration_backfill')
FROM selected_owners
ON CONFLICT (normalized_email) DO NOTHING;

CREATE OR REPLACE FUNCTION claim_recipient_outreach(p_lead_id UUID, p_phase TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email TEXT;
  v_owner UUID;
  v_bad TEXT;
BEGIN
  IF p_phase NOT IN ('initial','follow_up','reactivation') THEN RAISE EXCEPTION 'Invalid outreach phase'; END IF;
  SELECT normalized_email INTO v_email FROM leads WHERE id = p_lead_id FOR UPDATE;
  IF v_email IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'owner_lead_id', NULL, 'normalized_email', NULL, 'reason', 'invalid_email');
  END IF;
  SELECT issue_type INTO v_bad FROM lead_data_quality_flags
    WHERE lead_id = p_lead_id AND status = 'open' AND issue_type IN ('invalid_email','placeholder_email','technical_email') LIMIT 1;
  IF v_bad IS NOT NULL THEN
    UPDATE leads SET outreach_suppression_reason = v_bad, outreach_suppressed_at = now() WHERE id = p_lead_id;
    RETURN jsonb_build_object('allowed', false, 'owner_lead_id', NULL, 'normalized_email', v_email, 'reason', v_bad);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_email, 734921));
  SELECT owner_lead_id INTO v_owner FROM recipient_outreach_ownership WHERE normalized_email = v_email FOR UPDATE;
  IF v_owner IS NULL THEN
    SELECT l.id INTO v_owner
    FROM leads l JOIN emails e ON e.lead_id = l.id AND e.status IN ('sent','email_sync_failed')
    LEFT JOIN deals d ON d.lead_id = l.id
    WHERE l.normalized_email = v_email
    ORDER BY CASE WHEN d.id IS NOT NULL OR l.status IN ('replied','negotiating','interested','closed_won','closed','closed_manual') THEN 0 ELSE 1 END,
      e.sent_at ASC NULLS LAST, l.created_at ASC, l.id LIMIT 1;
  END IF;
  IF v_owner IS NULL THEN v_owner := p_lead_id; END IF;

  INSERT INTO recipient_outreach_ownership (normalized_email, owner_lead_id, metadata)
  VALUES (v_email, v_owner, jsonb_build_object('source', 'claim', 'phase', p_phase))
  ON CONFLICT (normalized_email) DO UPDATE SET
    owner_lead_id = COALESCE(recipient_outreach_ownership.owner_lead_id, EXCLUDED.owner_lead_id),
    state = 'active', last_activity_at = now();
  SELECT owner_lead_id INTO v_owner FROM recipient_outreach_ownership WHERE normalized_email = v_email;

  INSERT INTO lead_data_quality_flags (lead_id, normalized_email, issue_type, reason, related_lead_ids, metadata)
  SELECT l.id, v_email, 'already_contacted_email', 'Another lead owns the active outreach lifecycle for this recipient.', ARRAY[v_owner], jsonb_build_object('owner_lead_id', v_owner, 'phase', p_phase)
  FROM leads l WHERE l.normalized_email=v_email AND l.id<>v_owner
  ON CONFLICT DO NOTHING;

  IF v_owner <> p_lead_id THEN
    UPDATE leads SET outreach_suppression_reason = 'email_already_contacted', outreach_suppressed_at = now() WHERE id = p_lead_id;
    INSERT INTO lead_data_quality_flags (lead_id, normalized_email, issue_type, reason, related_lead_ids, metadata)
    VALUES (p_lead_id, v_email, 'already_contacted_email', 'Another lead owns the active outreach lifecycle for this recipient.', ARRAY[v_owner], jsonb_build_object('owner_lead_id', v_owner, 'phase', p_phase))
    ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('allowed', false, 'owner_lead_id', v_owner, 'normalized_email', v_email, 'reason', 'email_already_contacted');
  END IF;

  UPDATE leads SET outreach_suppression_reason = NULL, outreach_suppressed_at = NULL WHERE id = p_lead_id AND outreach_suppression_reason = 'email_already_contacted';
  RETURN jsonb_build_object('allowed', true, 'owner_lead_id', v_owner, 'normalized_email', v_email, 'reason', NULL);
END;
$$;

GRANT EXECUTE ON FUNCTION claim_recipient_outreach(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION refresh_lead_data_quality(UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION get_data_quality_report(
  p_issue_type TEXT DEFAULT NULL, p_email TEXT DEFAULT NULL, p_business TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL, p_city TEXT DEFAULT NULL, p_page INTEGER DEFAULT 1, p_page_size INTEGER DEFAULT 50
) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH lead_facts AS (
  SELECT l.*,
    regexp_replace(lower(COALESCE(l.business_name,'')), '[^a-z0-9]+', '', 'g') AS norm_name,
    regexp_replace(lower(COALESCE(l.phone,'')), '[^0-9]+', '', 'g') AS norm_phone,
    regexp_replace(lower(COALESCE(l.instagram_handle,'')), '[^a-z0-9]+', '', 'g') AS norm_social,
    regexp_replace(lower(COALESCE(l.address,'') || COALESCE(l.suburb,'')), '[^a-z0-9]+', '', 'g') AS norm_address,
    regexp_replace(lower(COALESCE(l.website,'')), '^https?://(www\.)?|/.*$', '', 'g') AS norm_domain,
    COUNT(DISTINCT e.id) FILTER (WHERE e.status IN ('sent','email_sync_failed'))::INT AS outreach_count,
    COUNT(DISTINCT e.id)::INT AS all_email_count,
    MAX(e.sent_at) FILTER (WHERE e.status IN ('sent','email_sync_failed')) AS latest_outreach_at,
    bool_or(e.replied_at IS NOT NULL) AS email_has_reply,
    bool_or(d.id IS NOT NULL) AS has_deal
  FROM leads l LEFT JOIN emails e ON e.lead_id=l.id LEFT JOIN deals d ON d.lead_id=l.id
  GROUP BY l.id
), groups AS (
  SELECT normalized_email, COUNT(*)::INT lead_count,
    array_agg(id ORDER BY created_at) lead_ids, array_agg(business_name ORDER BY created_at) business_names,
    array_agg(status ORDER BY created_at) statuses, array_agg(created_at ORDER BY created_at) created_at_values,
    SUM(outreach_count)::INT outreach_count, MAX(latest_outreach_at) latest_outreach_at,
    bool_or(email_has_reply OR status IN ('replied','negotiating','interested')) has_reply,
    bool_or(has_deal OR status IN ('closed','closed_won')) has_deal,
    bool_or(notes IS NOT NULL AND btrim(notes)<>'') has_notes,
    bool_or(outreach_count>0) has_email_history,
    COUNT(DISTINCT NULLIF(norm_name,'')) name_count, COUNT(DISTINCT NULLIF(norm_domain,'')) domain_count,
    COUNT(DISTINCT NULLIF(norm_phone,'')) phone_count, COUNT(DISTINCT NULLIF(norm_social,'')) social_count,
    COUNT(DISTINCT NULLIF(norm_address,'')) address_count,
    (array_agg(id ORDER BY
      (email_has_reply OR has_deal OR status IN ('replied','negotiating','interested','closed','closed_won')) DESC,
      CASE status WHEN 'closed_won' THEN 70 WHEN 'closed' THEN 65 WHEN 'negotiating' THEN 60 WHEN 'interested' THEN 55 WHEN 'replied' THEN 50 WHEN 'contacted' THEN 30 WHEN 'email_ready' THEN 20 WHEN 'researched' THEN 10 ELSE 0 END DESC,
      outreach_count DESC,
      (num_nonnulls(business_name,website,phone,address,suburb,instagram_handle)) DESC,
      created_at ASC,id))[1] preferred_lead_id,
    MAX(category_name) category_name, MAX(city) city
  FROM lead_facts WHERE normalized_email IS NOT NULL GROUP BY normalized_email HAVING COUNT(*) > 1
), group_issues AS (
  SELECT *, CASE
      WHEN name_count=1 OR (domain_count=1 AND phone_count=1) OR (domain_count=1 AND social_count=1) THEN 'duplicate_lead'
      WHEN name_count=lead_count AND (address_count=0 OR address_count>1) THEN 'shared_email'
      ELSE 'uncertain_email_group' END issue_type,
    CASE
      WHEN name_count=1 THEN ARRAY['same_normalized_email','same_normalized_business_name']
      WHEN domain_count=1 AND phone_count=1 THEN ARRAY['same_normalized_email','same_website_domain','same_phone']
      WHEN domain_count=1 AND social_count=1 THEN ARRAY['same_normalized_email','same_website_domain','same_social_handle']
      WHEN name_count=lead_count AND address_count>1 THEN ARRAY['same_normalized_email','different_business_names','different_addresses']
      WHEN name_count=lead_count THEN ARRAY['same_normalized_email','different_business_names']
      ELSE ARRAY['same_normalized_email','insufficient_deterministic_signals'] END reasons
  FROM groups
), flag_issues AS (
  SELECT f.normalized_email, f.issue_type, 1::INT lead_count, ARRAY[l.id] lead_ids, ARRAY[l.business_name] business_names,
    ARRAY[l.status] statuses, ARRAY[l.created_at] created_at_values,
    l.outreach_count, l.latest_outreach_at,
    (l.status IN ('replied','negotiating','interested') OR l.email_has_reply) has_reply,
    l.has_deal OR l.status IN ('closed','closed_won') has_deal,
    l.notes IS NOT NULL AND btrim(l.notes)<>'' has_notes,
    l.all_email_count>0 has_email_history,
    l.category_name, l.city, ARRAY[f.reason] reasons
  FROM lead_data_quality_flags f JOIN lead_facts l ON l.id=f.lead_id
  WHERE f.status='open' AND f.issue_type IN ('invalid_email','placeholder_email','technical_email','already_contacted_email')
), issues AS (
  SELECT normalized_email, issue_type, lead_count, lead_ids, business_names, statuses, created_at_values,
    outreach_count, latest_outreach_at, has_reply, has_deal, has_notes, has_email_history,
    false AS has_booking, (has_reply OR has_deal OR has_notes OR has_email_history) protected_from_auto_delete,
    preferred_lead_id, array_remove(lead_ids,preferred_lead_id) suggested_redundant_lead_ids,
    category_name, city, reasons
  FROM group_issues
  UNION ALL
  SELECT normalized_email, issue_type, lead_count, lead_ids, business_names, statuses, created_at_values,
    outreach_count, latest_outreach_at, has_reply, has_deal, has_notes, has_email_history,
    false, (has_reply OR has_deal OR has_notes OR has_email_history), lead_ids[1], ARRAY[]::UUID[], category_name, city, reasons FROM flag_issues
), filtered AS (
  SELECT * FROM issues WHERE (p_issue_type IS NULL OR issue_type=p_issue_type)
    AND (p_email IS NULL OR normalized_email ILIKE '%'||lower(btrim(p_email))||'%')
    AND (p_business IS NULL OR array_to_string(business_names,' ') ILIKE '%'||p_business||'%')
    AND (p_category IS NULL OR category_name=p_category) AND (p_city IS NULL OR city=p_city)
), paged AS (SELECT * FROM filtered ORDER BY latest_outreach_at DESC NULLS LAST, normalized_email LIMIT LEAST(GREATEST(p_page_size,1),200) OFFSET (GREATEST(p_page,1)-1)*LEAST(GREATEST(p_page_size,1),200))
SELECT jsonb_build_object('data',COALESCE(jsonb_agg(to_jsonb(paged)),'[]'::jsonb),'total',(SELECT COUNT(*) FROM filtered),'page',GREATEST(p_page,1),'page_size',LEAST(GREATEST(p_page_size,1),200)) FROM paged;
$$;

GRANT EXECUTE ON FUNCTION get_data_quality_report(TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,INTEGER) TO authenticated, service_role;

-- Persist the current group classification as well as deriving it in reports.
CREATE OR REPLACE FUNCTION refresh_email_group_quality(p_email TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count INT; v_names INT; v_domains INT; v_phones INT; v_socials INT; v_addresses INT;
  v_type TEXT; v_reasons TEXT[]; v_ids UUID[];
BEGIN
  IF p_email IS NULL THEN RETURN; END IF;
  DELETE FROM lead_data_quality_flags WHERE normalized_email=p_email AND status='open'
    AND issue_type IN ('duplicate_lead','shared_email','uncertain_email_group');
  SELECT COUNT(*), COUNT(DISTINCT NULLIF(regexp_replace(lower(COALESCE(business_name,'')),'[^a-z0-9]+','','g'),'')),
    COUNT(DISTINCT NULLIF(regexp_replace(lower(COALESCE(website,'')),'^https?://(www\.)?|/.*$','','g'),'')),
    COUNT(DISTINCT NULLIF(regexp_replace(COALESCE(phone,''),'[^0-9]+','','g'),'')),
    COUNT(DISTINCT NULLIF(regexp_replace(lower(COALESCE(instagram_handle,'')),'[^a-z0-9]+','','g'),'')),
    COUNT(DISTINCT NULLIF(regexp_replace(lower(COALESCE(address,'')||COALESCE(suburb,'')),'[^a-z0-9]+','','g'),'')),
    array_agg(id ORDER BY created_at)
  INTO v_count,v_names,v_domains,v_phones,v_socials,v_addresses,v_ids FROM leads WHERE normalized_email=p_email;
  IF v_count < 2 THEN RETURN; END IF;
  IF v_names=1 THEN v_type:='duplicate_lead'; v_reasons:=ARRAY['same_normalized_email','same_normalized_business_name'];
  ELSIF v_domains=1 AND v_phones=1 THEN v_type:='duplicate_lead'; v_reasons:=ARRAY['same_normalized_email','same_website_domain','same_phone'];
  ELSIF v_domains=1 AND v_socials=1 THEN v_type:='duplicate_lead'; v_reasons:=ARRAY['same_normalized_email','same_website_domain','same_social_handle'];
  ELSIF v_names=v_count AND (v_addresses=0 OR v_addresses>1) THEN v_type:='shared_email'; v_reasons:=ARRAY['same_normalized_email','different_business_names'] || CASE WHEN v_addresses>1 THEN ARRAY['different_addresses'] ELSE ARRAY[]::TEXT[] END;
  ELSE v_type:='uncertain_email_group'; v_reasons:=ARRAY['same_normalized_email','insufficient_deterministic_signals']; END IF;
  INSERT INTO lead_data_quality_flags(lead_id,normalized_email,issue_type,reason,related_lead_ids,metadata)
  SELECT id,p_email,v_type,array_to_string(v_reasons,', '),array_remove(v_ids,id),jsonb_build_object('signals',v_reasons)
  FROM leads WHERE normalized_email=p_email ON CONFLICT DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION refresh_lead_data_quality(p_lead_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_email TEXT; v_type TEXT; v_reason TEXT; v_owner UUID;
BEGIN
  SELECT normalized_email INTO v_email FROM leads WHERE id=p_lead_id;
  DELETE FROM lead_data_quality_flags WHERE lead_id=p_lead_id AND status='open'
    AND issue_type IN ('invalid_email','placeholder_email','technical_email');
  SELECT q.issue_type,q.reason INTO v_type,v_reason FROM classify_email_quality((SELECT email FROM leads WHERE id=p_lead_id)) q LIMIT 1;
  IF v_type IS NOT NULL THEN
    INSERT INTO lead_data_quality_flags(lead_id,normalized_email,issue_type,reason) VALUES(p_lead_id,v_email,v_type,v_reason) ON CONFLICT DO NOTHING;
  END IF;
  SELECT owner_lead_id INTO v_owner FROM recipient_outreach_ownership WHERE normalized_email=v_email AND state='active';
  DELETE FROM lead_data_quality_flags WHERE lead_id=p_lead_id AND status='open' AND issue_type='already_contacted_email';
  IF v_owner IS NOT NULL AND v_owner<>p_lead_id THEN
    INSERT INTO lead_data_quality_flags(lead_id,normalized_email,issue_type,reason,related_lead_ids,metadata)
    VALUES(p_lead_id,v_email,'already_contacted_email','Another lead owns the active outreach lifecycle for this recipient.',ARRAY[v_owner],jsonb_build_object('owner_lead_id',v_owner)) ON CONFLICT DO NOTHING;
  END IF;
  PERFORM refresh_email_group_quality(v_email);
END;
$$;

CREATE OR REPLACE FUNCTION trigger_refresh_lead_data_quality()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.normalized_email IS DISTINCT FROM NEW.normalized_email THEN PERFORM refresh_email_group_quality(OLD.normalized_email); END IF;
  PERFORM refresh_lead_data_quality(NEW.id); RETURN NEW;
END;
$$;

DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT DISTINCT normalized_email FROM leads WHERE normalized_email IS NOT NULL LOOP PERFORM refresh_email_group_quality(r.normalized_email); END LOOP;
END $$;

-- Existing non-owner leads are immediately visible as already-contacted in a
-- dry run; no send attempt is required to discover them.
INSERT INTO lead_data_quality_flags(lead_id,normalized_email,issue_type,reason,related_lead_ids,metadata)
SELECT l.id,l.normalized_email,'already_contacted_email','Another lead owns the active outreach lifecycle for this recipient.',ARRAY[o.owner_lead_id],jsonb_build_object('owner_lead_id',o.owner_lead_id,'source','migration_backfill')
FROM leads l JOIN recipient_outreach_ownership o ON o.normalized_email=l.normalized_email
WHERE o.owner_lead_id IS NOT NULL AND l.id<>o.owner_lead_id ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION get_data_quality_summary()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
WITH group_rows AS (
  SELECT normalized_email, COUNT(*)::INT lead_count,
    COUNT(DISTINCT NULLIF(regexp_replace(lower(COALESCE(business_name,'')),'[^a-z0-9]+','','g'),'')) names,
    COUNT(DISTINCT NULLIF(regexp_replace(lower(COALESCE(website,'')),'^https?://(www\.)?|/.*$','','g'),'')) domains,
    COUNT(DISTINCT NULLIF(regexp_replace(COALESCE(phone,''),'[^0-9]+','','g'),'')) phones,
    COUNT(DISTINCT NULLIF(regexp_replace(lower(COALESCE(instagram_handle,'')),'[^a-z0-9]+','','g'),'')) socials,
    COUNT(DISTINCT NULLIF(regexp_replace(lower(COALESCE(address,'')||COALESCE(suburb,'')),'[^a-z0-9]+','','g'),'')) addresses
  FROM leads WHERE normalized_email IS NOT NULL GROUP BY normalized_email HAVING COUNT(*)>1
), classified AS (
  SELECT *,CASE WHEN names=1 OR (domains=1 AND phones=1) OR (domains=1 AND socials=1) THEN 'duplicate_lead'
    WHEN names=lead_count AND (addresses=0 OR addresses>1) THEN 'shared_email' ELSE 'uncertain_email_group' END issue_type FROM group_rows
), protected AS (
  SELECT DISTINCT l.id FROM leads l LEFT JOIN emails e ON e.lead_id=l.id LEFT JOIN deals d ON d.lead_id=l.id
  WHERE l.normalized_email IN (SELECT normalized_email FROM classified WHERE issue_type='duplicate_lead')
    AND (l.status IN ('replied','negotiating','interested','closed','closed_won','closed_manual') OR l.notes IS NOT NULL OR e.id IS NOT NULL OR d.id IS NOT NULL)
), duplicate_members AS (
  SELECT SUM(lead_count)::INT total FROM classified WHERE issue_type='duplicate_lead'
)
SELECT jsonb_build_object(
  'duplicate_lead_groups',COUNT(*) FILTER(WHERE issue_type='duplicate_lead'),
  'shared_email_groups',COUNT(*) FILTER(WHERE issue_type='shared_email'),
  'uncertain_email_groups',COUNT(*) FILTER(WHERE issue_type='uncertain_email_group'),
  'placeholder_emails',(SELECT COUNT(*) FROM lead_data_quality_flags WHERE status='open' AND issue_type='placeholder_email'),
  'technical_emails',(SELECT COUNT(*) FROM lead_data_quality_flags WHERE status='open' AND issue_type='technical_email'),
  'invalid_emails',(SELECT COUNT(*) FROM lead_data_quality_flags WHERE status='open' AND issue_type='invalid_email'),
  'already_contacted_email_leads',(SELECT COUNT(*) FROM lead_data_quality_flags WHERE status='open' AND issue_type='already_contacted_email'),
  'protected_duplicate_records',(SELECT COUNT(*) FROM protected),
  'safe_looking_duplicate_candidates',GREATEST(COALESCE((SELECT total FROM duplicate_members),0)-(SELECT COUNT(*) FROM protected)-COUNT(*) FILTER(WHERE issue_type='duplicate_lead'),0)
) FROM classified;
$$;
GRANT EXECUTE ON FUNCTION get_data_quality_summary() TO authenticated, service_role;
