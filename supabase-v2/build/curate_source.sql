\set ON_ERROR_STOP on

BEGIN;

-- Remove the catalog-confirmed unrelated WhatsApp/bookings product.
DROP VIEW IF EXISTS public.v_bookings_full CASCADE;
DROP VIEW IF EXISTS public.v_conversation_thread CASCADE;
DROP VIEW IF EXISTS public.v_daily_summary CASCADE;
DROP TABLE IF EXISTS public.bookings CASCADE;
DROP TABLE IF EXISTS public.clients CASCADE;
DROP TABLE IF EXISTS public.conversations CASCADE;
DROP TABLE IF EXISTS public.customers CASCADE;
DROP TABLE IF EXISTS public.escalations CASCADE;
DROP TABLE IF EXISTS public.knowledge_base CASCADE;
DROP TABLE IF EXISTS public.weekly_reports CASCADE;
DROP FUNCTION IF EXISTS public.set_updated_at() CASCADE;
DROP FUNCTION IF EXISTS public.update_customer_on_message() CASCADE;

-- Keep only the ReachAgent-required extension, in a non-client-writable schema.
DROP SCHEMA IF EXISTS extensions CASCADE;
CREATE SCHEMA extensions;
ALTER EXTENSION pg_trgm SET SCHEMA extensions;
REVOKE ALL ON SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SCHEMA extensions FROM PUBLIC, anon, authenticated;

-- A no-login, RLS-bypassing function owner provides narrowly granted definer
-- authority without using an application login role.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reachagent_function_owner') THEN
    CREATE ROLE reachagent_function_owner NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$do$;
GRANT USAGE ON SCHEMA public, auth TO reachagent_function_owner;

-- Approved V2 schema strengthenings.
ALTER TABLE public.city_suburbs
  ALTER COLUMN priority SET DEFAULT 1,
  ALTER COLUMN priority SET NOT NULL;
ALTER TABLE public.city_suburbs
  DROP CONSTRAINT IF EXISTS city_suburbs_priority_check;
ALTER TABLE public.city_suburbs
  ADD CONSTRAINT city_suburbs_priority_check CHECK (priority BETWEEN 1 AND 10);

ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE public.leads
  ADD CONSTRAINT leads_status_check CHECK (status = ANY (ARRAY[
    'new'::text, 'researched'::text, 'email_ready'::text,
    'contacted'::text, 'replied'::text, 'interested'::text,
    'negotiating'::text, 'closed'::text, 'closed_manual'::text,
    'dead'::text
  ]));

COMMENT ON COLUMN public.leads.category_id IS
  'Authoritative category identity. Nullable only for staged legacy import; a later validated V2 migration sets NOT NULL after exact/approved-alias remediation reaches zero ambiguous/unmatched rows.';

-- One deterministic trigger normalizes source fields and derives normalized_email.
DROP TRIGGER IF EXISTS leads_set_normalized_email ON public.leads;
DROP TRIGGER IF EXISTS normalize_lead_fields_trigger ON public.leads;
DROP FUNCTION IF EXISTS public.set_lead_normalized_email();

CREATE OR REPLACE FUNCTION public.normalize_lead_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  NEW.business_name := NULLIF(pg_catalog.btrim(NEW.business_name), '');
  NEW.email := NULLIF(pg_catalog.btrim(NEW.email), '');
  NEW.normalized_email := NULLIF(pg_catalog.lower(NEW.email), '');
  RETURN NEW;
END
$fn$;

CREATE TRIGGER leads_normalize_fields
  BEFORE INSERT OR UPDATE OF business_name, email, normalized_email
  ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.normalize_lead_fields();

-- Safe Auth trigger contract: metadata can supply display name only.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, is_active)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    NEW.raw_user_meta_data ->> 'full_name',
    'member',
    true
  )
  ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name);
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- Put legacy implementations behind a private, non-client-accessible schema.
CREATE SCHEMA IF NOT EXISTS reachagent_private;
REVOKE ALL ON SCHEMA reachagent_private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA reachagent_private TO reachagent_function_owner;

ALTER FUNCTION public.claim_hostinger_inbound_receipt(uuid,text,timestamptz) SET SCHEMA reachagent_private;
ALTER FUNCTION reachagent_private.claim_hostinger_inbound_receipt(uuid,text,timestamptz) SECURITY INVOKER;
ALTER FUNCTION public.claim_recipient_outreach(uuid,text) SET SCHEMA reachagent_private;
ALTER FUNCTION reachagent_private.claim_recipient_outreach(uuid,text) SECURITY INVOKER;
ALTER FUNCTION public.get_ai_request_analytics(timestamptz,timestamptz,text,text,text,integer) SET SCHEMA reachagent_private;
ALTER FUNCTION reachagent_private.get_ai_request_analytics(timestamptz,timestamptz,text,text,text,integer) SECURITY INVOKER;
ALTER FUNCTION public.get_data_quality_report(text,text,text,text,text,integer,integer) SET SCHEMA reachagent_private;
ALTER FUNCTION reachagent_private.get_data_quality_report(text,text,text,text,text,integer,integer) SECURITY INVOKER;
ALTER FUNCTION public.get_data_quality_report_v2(text,text,text,text,text,text,integer,integer) SET SCHEMA reachagent_private;
ALTER FUNCTION reachagent_private.get_data_quality_report_v2(text,text,text,text,text,text,integer,integer) SECURITY INVOKER;
ALTER FUNCTION public.get_data_quality_summary() SET SCHEMA reachagent_private;
ALTER FUNCTION reachagent_private.get_data_quality_summary() SECURITY INVOKER;
ALTER FUNCTION public.is_active_admin() SET SCHEMA reachagent_private;
ALTER FUNCTION reachagent_private.is_active_admin() SECURITY INVOKER;
ALTER FUNCTION public.refresh_email_group_quality(text) SET SCHEMA reachagent_private;
ALTER FUNCTION reachagent_private.refresh_email_group_quality(text) SECURITY INVOKER;
ALTER FUNCTION public.refresh_lead_data_quality(uuid) SET SCHEMA reachagent_private;
ALTER FUNCTION reachagent_private.refresh_lead_data_quality(uuid) SECURITY INVOKER;
ALTER FUNCTION public.release_recipient_outreach_claim(uuid,text,uuid) SET SCHEMA reachagent_private;
ALTER FUNCTION reachagent_private.release_recipient_outreach_claim(uuid,text,uuid) SECURITY INVOKER;

ALTER FUNCTION reachagent_private.claim_hostinger_inbound_receipt(uuid,text,timestamptz) SET search_path = pg_catalog, public;
ALTER FUNCTION reachagent_private.claim_recipient_outreach(uuid,text) SET search_path = pg_catalog, public;
ALTER FUNCTION reachagent_private.get_ai_request_analytics(timestamptz,timestamptz,text,text,text,integer) SET search_path = pg_catalog, public;
ALTER FUNCTION reachagent_private.get_data_quality_report(text,text,text,text,text,integer,integer) SET search_path = pg_catalog, public;
ALTER FUNCTION reachagent_private.get_data_quality_report_v2(text,text,text,text,text,text,integer,integer) SET search_path = pg_catalog, public;
ALTER FUNCTION reachagent_private.get_data_quality_summary() SET search_path = pg_catalog, public;
ALTER FUNCTION reachagent_private.is_active_admin() SET search_path = pg_catalog, public;
ALTER FUNCTION reachagent_private.refresh_email_group_quality(text) SET search_path = pg_catalog, public;
ALTER FUNCTION reachagent_private.refresh_lead_data_quality(uuid) SET search_path = pg_catalog, reachagent_private, public;
ALTER FUNCTION reachagent_private.release_recipient_outreach_claim(uuid,text,uuid) SET search_path = pg_catalog, public;

-- Public SECURITY DEFINER wrappers contain validation/authorization and only a
-- schema-qualified call into a non-executable private implementation.
CREATE FUNCTION public.is_active_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT reachagent_private.is_active_admin()
$fn$;

CREATE FUNCTION public.claim_hostinger_inbound_receipt(
  p_receipt_id uuid, p_run_id text, p_stale_before timestamptz
) RETURNS TABLE(receipt_id uuid, attempt_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501'; END IF;
  IF p_receipt_id IS NULL OR NULLIF(pg_catalog.btrim(p_run_id),'') IS NULL OR length(p_run_id) > 200 THEN
    RAISE EXCEPTION 'invalid receipt claim parameters';
  END IF;
  IF p_stale_before IS NULL OR p_stale_before > pg_catalog.now() OR p_stale_before < pg_catalog.now() - interval '7 days' THEN
    RAISE EXCEPTION 'stale cutoff must be within the preceding 7 days';
  END IF;
  RETURN QUERY SELECT * FROM reachagent_private.claim_hostinger_inbound_receipt(p_receipt_id,p_run_id,p_stale_before);
END
$fn$;

CREATE FUNCTION public.claim_recipient_outreach(p_lead_id uuid, p_phase text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501'; END IF;
  IF p_lead_id IS NULL OR p_phase NOT IN ('initial','follow_up','reactivation') THEN RAISE EXCEPTION 'invalid outreach claim parameters'; END IF;
  RETURN reachagent_private.claim_recipient_outreach(p_lead_id,p_phase);
END
$fn$;

CREATE FUNCTION public.get_ai_request_analytics(
  p_start_at timestamptz DEFAULT NULL, p_end_at timestamptz DEFAULT NULL,
  p_workflow text DEFAULT NULL, p_provider text DEFAULT NULL,
  p_status text DEFAULT NULL, p_recent_limit integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_active_admin() THEN RAISE EXCEPTION 'active admin required' USING ERRCODE='42501'; END IF;
  IF p_recent_limit NOT BETWEEN 1 AND 500 OR (p_start_at IS NOT NULL AND p_end_at IS NOT NULL AND p_start_at >= p_end_at) THEN RAISE EXCEPTION 'invalid analytics bounds'; END IF;
  RETURN reachagent_private.get_ai_request_analytics(p_start_at,p_end_at,p_workflow,p_provider,p_status,p_recent_limit);
END
$fn$;

CREATE FUNCTION public.get_data_quality_report(
  p_issue_type text DEFAULT NULL, p_email text DEFAULT NULL,
  p_business text DEFAULT NULL, p_category text DEFAULT NULL,
  p_city text DEFAULT NULL, p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_active_admin() THEN RAISE EXCEPTION 'active admin required' USING ERRCODE='42501'; END IF;
  IF p_page < 1 OR p_page_size NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid pagination'; END IF;
  RETURN reachagent_private.get_data_quality_report(p_issue_type,p_email,p_business,p_category,p_city,p_page,p_page_size);
END
$fn$;

CREATE FUNCTION public.get_data_quality_report_v2(
  p_issue_type text DEFAULT NULL, p_search text DEFAULT NULL,
  p_email text DEFAULT NULL, p_business text DEFAULT NULL,
  p_category text DEFAULT NULL, p_city text DEFAULT NULL,
  p_page integer DEFAULT 1, p_page_size integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_active_admin() THEN RAISE EXCEPTION 'active admin required' USING ERRCODE='42501'; END IF;
  IF p_page < 1 OR p_page_size NOT BETWEEN 1 AND 500 OR length(COALESCE(p_search,'')) > 500 THEN RAISE EXCEPTION 'invalid report bounds'; END IF;
  RETURN reachagent_private.get_data_quality_report_v2(p_issue_type,p_search,p_email,p_business,p_category,p_city,p_page,p_page_size);
END
$fn$;

CREATE FUNCTION public.get_data_quality_summary()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_active_admin() THEN RAISE EXCEPTION 'active admin required' USING ERRCODE='42501'; END IF;
  RETURN reachagent_private.get_data_quality_summary();
END
$fn$;

CREATE FUNCTION public.refresh_email_group_quality(p_email text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501'; END IF;
  PERFORM reachagent_private.refresh_email_group_quality(NULLIF(pg_catalog.lower(pg_catalog.btrim(p_email)),''));
END
$fn$;

CREATE FUNCTION public.refresh_lead_data_quality(p_lead_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501'; END IF;
  IF p_lead_id IS NULL THEN RAISE EXCEPTION 'lead id required'; END IF;
  PERFORM reachagent_private.refresh_lead_data_quality(p_lead_id);
END
$fn$;

CREATE FUNCTION public.release_recipient_outreach_claim(
  p_lead_id uuid, p_normalized_email text, p_claim_token uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE='42501'; END IF;
  IF p_lead_id IS NULL OR p_claim_token IS NULL OR NULLIF(pg_catalog.btrim(p_normalized_email),'') IS NULL THEN RAISE EXCEPTION 'invalid release parameters'; END IF;
  RETURN reachagent_private.release_recipient_outreach_claim(p_lead_id,p_normalized_email,p_claim_token);
END
$fn$;

-- Redesign actor-taking mutations. Caller identity is never accepted as input.
DROP FUNCTION public.remove_data_quality_emails(uuid[],uuid);
CREATE FUNCTION public.remove_data_quality_emails(p_lead_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_ids uuid[];
  v_requested integer;
  v_found integer;
  v_blocked record;
  v_actor uuid := auth.uid();
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_active_admin() THEN RAISE EXCEPTION 'active admin required' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(DISTINCT x.id),'{}'::uuid[]) INTO v_ids FROM pg_catalog.unnest(p_lead_ids) AS x(id);
  v_requested := cardinality(v_ids);
  IF v_requested < 1 OR v_requested > 100 THEN RAISE EXCEPTION 'Select between 1 and 100 leads'; END IF;
  PERFORM 1 FROM public.leads WHERE id=ANY(v_ids) FOR UPDATE;
  SELECT count(*) INTO v_found FROM public.leads WHERE id=ANY(v_ids);
  IF v_found <> v_requested THEN RAISE EXCEPTION 'One or more selected leads no longer exist'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.leads l WHERE l.id=ANY(v_ids) AND NOT EXISTS (
      SELECT 1 FROM public.lead_data_quality_flags f
      WHERE f.lead_id=l.id AND f.status='open'
        AND f.issue_type IN ('invalid_email','placeholder_email','technical_email')
    )
  ) THEN RAISE EXCEPTION 'Every selected lead must have an open invalid, placeholder, or technical email flag'; END IF;
  SELECT l.id,l.business_name INTO v_blocked FROM public.leads l
  WHERE l.id=ANY(v_ids) AND (
    l.status IN ('replied','negotiating','interested','closed','closed_manual')
    OR NULLIF(pg_catalog.btrim(l.notes),'') IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.emails e WHERE e.lead_id=l.id)
    OR EXISTS (SELECT 1 FROM public.deals d WHERE d.lead_id=l.id)
  ) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'Email removal blocked: lead % is protected by lifecycle or history',v_blocked.id; END IF;
  IF EXISTS (
    SELECT 1 FROM public.leads l JOIN public.recipient_outreach_ownership o
      ON o.owner_lead_id=l.id AND o.normalized_email=l.normalized_email AND o.state='active'
    WHERE l.id=ANY(v_ids)
  ) THEN RAISE EXCEPTION 'Email removal blocked: selected lead owns the active recipient outreach lifecycle'; END IF;
  WITH originals AS (
    SELECT l.id,l.normalized_email,
      (SELECT f.issue_type FROM public.lead_data_quality_flags f
       WHERE f.lead_id=l.id AND f.status='open'
         AND f.issue_type IN ('invalid_email','placeholder_email','technical_email')
       ORDER BY f.created_at LIMIT 1) AS issue_type
    FROM public.leads l WHERE l.id=ANY(v_ids)
  ), changed AS (
    UPDATE public.leads l SET email=NULL,updated_at=pg_catalog.now()
    FROM originals o WHERE l.id=o.id
    RETURNING l.id,o.normalized_email,o.issue_type
  )
  INSERT INTO public.activity_log(event_type,lead_id,description,metadata)
  SELECT 'data_quality_email_removed',id,'Invalid or junk email removed by an admin.',
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'issue_type',issue_type,'normalized_email',normalized_email,
      'actor_id',v_actor,'actor_kind',CASE WHEN v_actor IS NULL THEN 'service_role' ELSE 'user' END))
  FROM changed;
  RETURN pg_catalog.jsonb_build_object('updated',v_requested,'lead_ids',v_ids);
END
$fn$;

DROP FUNCTION public.set_data_quality_flag_status(text,text,uuid[],text,text,uuid);
CREATE FUNCTION public.set_data_quality_flag_status(
  p_issue_type text, p_normalized_email text DEFAULT NULL,
  p_lead_ids uuid[] DEFAULT NULL, p_status text DEFAULT 'resolved',
  p_resolution_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_ids uuid[];
  v_count integer;
  v_actor uuid := auth.uid();
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.is_active_admin() THEN RAISE EXCEPTION 'active admin required' USING ERRCODE='42501'; END IF;
  IF p_issue_type NOT IN ('duplicate_lead','shared_email','uncertain_email_group','invalid_email','placeholder_email','technical_email','already_contacted_email') THEN RAISE EXCEPTION 'Unsupported data-quality issue type'; END IF;
  IF p_status NOT IN ('resolved','open') THEN RAISE EXCEPTION 'Unsupported flag transition'; END IF;
  IF COALESCE(cardinality(p_lead_ids),0) > 100 THEN RAISE EXCEPTION 'Select no more than 100 leads'; END IF;
  IF p_issue_type IN ('duplicate_lead','shared_email','uncertain_email_group') AND NULLIF(pg_catalog.btrim(p_normalized_email),'') IS NULL THEN RAISE EXCEPTION 'A recipient email is required for grouped issues'; END IF;
  IF p_issue_type NOT IN ('duplicate_lead','shared_email','uncertain_email_group') AND COALESCE(cardinality(p_lead_ids),0)=0 THEN RAISE EXCEPTION 'At least one lead is required'; END IF;
  IF p_normalized_email IS NOT NULL AND p_lead_ids IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_catalog.unnest(p_lead_ids) x(id)
    WHERE NOT EXISTS (SELECT 1 FROM public.leads l WHERE l.id=x.id AND l.normalized_email=p_normalized_email)
  ) THEN RAISE EXCEPTION 'Selected leads do not belong to the addressed email group'; END IF;
  IF p_status='resolved' THEN
    WITH changed AS (
      UPDATE public.lead_data_quality_flags SET status='resolved', resolved_at=pg_catalog.now(), updated_at=pg_catalog.now(),
        resolution_reason=NULLIF(pg_catalog.btrim(p_resolution_reason),''), resolved_by=v_actor
      WHERE issue_type=p_issue_type AND status='open'
        AND (p_normalized_email IS NULL OR normalized_email=p_normalized_email)
        AND (p_lead_ids IS NULL OR lead_id=ANY(p_lead_ids))
      RETURNING lead_id
    ) SELECT COALESCE(array_agg(DISTINCT lead_id),'{}'::uuid[]) INTO v_ids FROM changed;
  ELSE
    WITH candidates AS (
      SELECT DISTINCT ON (lead_id,issue_type,COALESCE(normalized_email,'')) id,lead_id
      FROM public.lead_data_quality_flags f
      WHERE issue_type=p_issue_type AND status='resolved'
        AND (p_normalized_email IS NULL OR normalized_email=p_normalized_email)
        AND (p_lead_ids IS NULL OR lead_id=ANY(p_lead_ids))
        AND NOT EXISTS (
          SELECT 1 FROM public.lead_data_quality_flags o
          WHERE o.status='open' AND o.lead_id=f.lead_id AND o.issue_type=f.issue_type
            AND COALESCE(o.normalized_email,'')=COALESCE(f.normalized_email,'')
        )
      ORDER BY lead_id,issue_type,COALESCE(normalized_email,''),resolved_at DESC NULLS LAST
    ), changed AS (
      UPDATE public.lead_data_quality_flags f SET status='open',resolved_at=NULL,updated_at=pg_catalog.now(),resolution_reason=NULL,resolved_by=NULL
      FROM candidates c WHERE f.id=c.id RETURNING f.lead_id
    ) SELECT COALESCE(array_agg(DISTINCT lead_id),'{}'::uuid[]) INTO v_ids FROM changed;
  END IF;
  v_count:=cardinality(v_ids);
  IF v_count=0 THEN RAISE EXCEPTION 'No matching flags were available for this transition'; END IF;
  INSERT INTO public.activity_log(event_type,lead_id,description,metadata)
  SELECT CASE WHEN p_status='resolved' THEN 'data_quality_flag_resolved' ELSE 'data_quality_flag_reopened' END,
    id,CASE WHEN p_status='resolved' THEN 'Data Quality flag resolved by an admin.' ELSE 'Data Quality flag reopened by an admin.' END,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'issue_type',p_issue_type,'normalized_email',p_normalized_email,
      'actor_id',v_actor,'actor_kind',CASE WHEN v_actor IS NULL THEN 'service_role' ELSE 'user' END,
      'resolution_reason',NULLIF(pg_catalog.btrim(p_resolution_reason),'')))
  FROM pg_catalog.unnest(v_ids) id;
  RETURN pg_catalog.jsonb_build_object('updated',v_count,'lead_ids',v_ids,'status',p_status);
END
$fn$;

-- Schema-qualify trigger-only SECURITY DEFINER bodies.
CREATE OR REPLACE FUNCTION public.clear_lead_outreach_suppression_on_email_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE v_bad text;
BEGIN
  IF NULLIF(pg_catalog.lower(pg_catalog.btrim(OLD.email)), '') IS DISTINCT FROM NULLIF(pg_catalog.lower(pg_catalog.btrim(NEW.email)), '') THEN
    SELECT q.issue_type INTO v_bad FROM public.classify_email_quality(NEW.email) q LIMIT 1;
    UPDATE public.leads
    SET outreach_suppression_reason=v_bad,
        outreach_suppressed_at=CASE WHEN v_bad IS NULL THEN NULL ELSE COALESCE(outreach_suppressed_at,pg_catalog.now()) END
    WHERE id=NEW.id;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.trigger_refresh_lead_data_quality()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF TG_OP='UPDATE' AND OLD.normalized_email IS DISTINCT FROM NEW.normalized_email THEN
    PERFORM reachagent_private.refresh_email_group_quality(OLD.normalized_email);
  END IF;
  PERFORM reachagent_private.refresh_lead_data_quality(NEW.id);
  RETURN NEW;
END
$fn$;

-- Own all definer code with the no-login role and allow its private invoker
-- implementations to operate. Client roles never receive private-schema usage.
ALTER FUNCTION public.handle_new_auth_user() OWNER TO reachagent_function_owner;
ALTER FUNCTION public.is_active_admin() OWNER TO reachagent_function_owner;
ALTER FUNCTION public.claim_hostinger_inbound_receipt(uuid,text,timestamptz) OWNER TO reachagent_function_owner;
ALTER FUNCTION public.claim_recipient_outreach(uuid,text) OWNER TO reachagent_function_owner;
ALTER FUNCTION public.clear_lead_outreach_suppression_on_email_change() OWNER TO reachagent_function_owner;
ALTER FUNCTION public.get_ai_request_analytics(timestamptz,timestamptz,text,text,text,integer) OWNER TO reachagent_function_owner;
ALTER FUNCTION public.get_data_quality_report(text,text,text,text,text,integer,integer) OWNER TO reachagent_function_owner;
ALTER FUNCTION public.get_data_quality_report_v2(text,text,text,text,text,text,integer,integer) OWNER TO reachagent_function_owner;
ALTER FUNCTION public.get_data_quality_summary() OWNER TO reachagent_function_owner;
ALTER FUNCTION public.refresh_email_group_quality(text) OWNER TO reachagent_function_owner;
ALTER FUNCTION public.refresh_lead_data_quality(uuid) OWNER TO reachagent_function_owner;
ALTER FUNCTION public.release_recipient_outreach_claim(uuid,text,uuid) OWNER TO reachagent_function_owner;
ALTER FUNCTION public.remove_data_quality_emails(uuid[]) OWNER TO reachagent_function_owner;
ALTER FUNCTION public.set_data_quality_flag_status(text,text,uuid[],text,text) OWNER TO reachagent_function_owner;
ALTER FUNCTION public.trigger_refresh_lead_data_quality() OWNER TO reachagent_function_owner;

ALTER FUNCTION reachagent_private.claim_hostinger_inbound_receipt(uuid,text,timestamptz) OWNER TO reachagent_function_owner;
ALTER FUNCTION reachagent_private.claim_recipient_outreach(uuid,text) OWNER TO reachagent_function_owner;
ALTER FUNCTION reachagent_private.get_ai_request_analytics(timestamptz,timestamptz,text,text,text,integer) OWNER TO reachagent_function_owner;
ALTER FUNCTION reachagent_private.get_data_quality_report(text,text,text,text,text,integer,integer) OWNER TO reachagent_function_owner;
ALTER FUNCTION reachagent_private.get_data_quality_report_v2(text,text,text,text,text,text,integer,integer) OWNER TO reachagent_function_owner;
ALTER FUNCTION reachagent_private.get_data_quality_summary() OWNER TO reachagent_function_owner;
ALTER FUNCTION reachagent_private.is_active_admin() OWNER TO reachagent_function_owner;
ALTER FUNCTION reachagent_private.refresh_email_group_quality(text) OWNER TO reachagent_function_owner;
ALTER FUNCTION reachagent_private.refresh_lead_data_quality(uuid) OWNER TO reachagent_function_owner;
ALTER FUNCTION reachagent_private.release_recipient_outreach_claim(uuid,text,uuid) OWNER TO reachagent_function_owner;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO reachagent_function_owner;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, reachagent_private TO reachagent_function_owner;

-- Remove every production policy and recreate the approved V2 policy surface.
DO $do$
DECLARE p record;
BEGIN
  FOR p IN SELECT schemaname,tablename,policyname FROM pg_policies WHERE schemaname='public'
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I',p.policyname,p.schemaname,p.tablename);
  END LOOP;
END
$do$;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'activity_log','ai_models','ai_providers','ai_request_logs','ai_workflow_configurations',
    'categories','category_email_templates','category_suburb_priorities','category_suburb_search_state',
    'city_suburbs','dead_letter_queue','deals','discovery_run_metrics','distributed_locks','dm_queue',
    'emails','exhausted_queries','follow_ups','inbound_receipts','lead_data_quality_flags','leads',
    'profiles','recipient_outreach_ownership','search_cache','settings'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY',t);
  END LOOP;
END
$do$;

-- Profile policies are the root predicates for active-member checks.
CREATE POLICY profiles_read_own ON public.profiles FOR SELECT TO authenticated
  USING (id=auth.uid());
CREATE POLICY profiles_admin_read ON public.profiles FOR SELECT TO authenticated
  USING (public.is_active_admin());
CREATE POLICY profiles_update_own_display ON public.profiles FOR UPDATE TO authenticated
  USING (id=auth.uid() AND is_active) WITH CHECK (id=auth.uid() AND is_active);

-- Member operational tables.
CREATE POLICY leads_member_read ON public.leads FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active));
CREATE POLICY leads_member_insert ON public.leads FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active));
CREATE POLICY leads_member_update ON public.leads FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active));
CREATE POLICY leads_admin_delete ON public.leads FOR DELETE TO authenticated USING (public.is_active_admin());

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['follow_ups','dm_queue','deals'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active))',t||'_member_read',t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active))',t||'_member_insert',t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active)) WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active))',t||'_member_update',t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.is_active_admin())',t||'_admin_delete',t);
  END LOOP;
END
$do$;

CREATE POLICY emails_member_read ON public.emails FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active));
CREATE POLICY activity_member_read ON public.activity_log FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active));
CREATE POLICY activity_member_append ON public.activity_log FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active));

-- Readable configuration with admin-only mutation.
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'categories','category_email_templates','city_suburbs','category_suburb_priorities',
    'ai_providers','ai_models','ai_workflow_configurations'
  ] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active))',t||'_member_read',t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_active_admin()) WITH CHECK (public.is_active_admin())',t||'_admin_manage',t);
  END LOOP;
END
$do$;

CREATE POLICY settings_member_read_allowlist ON public.settings FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active)
    AND key=ANY(ARRAY[
      'active_cities','system_active','daily_lead_limit','daily_initial_outreach_limit',
      'daily_dm_limit','daily_outscraper_limit','daily_followup1_limit','daily_followup2_limit',
      'daily_followup3_limit','daily_reactivation_limit','follow_up_1_days','follow_up_2_days',
      'follow_up_3_days','dead_lead_days','reactivation_enabled','reactivation_delay_days',
      'dead_after_reactivation_days','enable_lead_filtering','blocked_business_keywords',
      'primary_search_api','initial_email_mode'
    ]::text[])
  );
CREATE POLICY settings_admin_manage ON public.settings FOR ALL TO authenticated
  USING (public.is_active_admin()) WITH CHECK (public.is_active_admin());

CREATE POLICY quality_member_read ON public.lead_data_quality_flags FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active));
CREATE POLICY ownership_member_read ON public.recipient_outreach_ownership FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active));

-- Admin diagnostics; mutations remain service-only.
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'category_suburb_search_state','exhausted_queries','search_cache','discovery_run_metrics',
    'ai_request_logs','inbound_receipts','dead_letter_queue'
  ] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_active_admin())',t||'_admin_read',t);
  END LOOP;
END
$do$;

-- Strip all inherited/broad ACLs, then grant only the approved surface.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA reachagent_private FROM PUBLIC, anon, authenticated, service_role;

GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.leads,public.follow_ups,public.dm_queue,public.deals TO authenticated;
GRANT SELECT ON public.emails TO authenticated;
GRANT SELECT,INSERT ON public.activity_log TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.categories,public.category_email_templates,public.city_suburbs,public.category_suburb_priorities,public.ai_providers,public.ai_models,public.ai_workflow_configurations,public.settings TO authenticated;
GRANT SELECT ON public.category_suburb_search_state,public.exhausted_queries,public.search_cache,public.discovery_run_metrics,public.ai_request_logs,public.inbound_receipts,public.dead_letter_queue,public.lead_data_quality_flags,public.recipient_outreach_ownership TO authenticated;
GRANT SELECT ON public.profiles TO authenticated;
GRANT UPDATE(full_name) ON public.profiles TO authenticated;

GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Approved SECURITY DEFINER execution matrix.
GRANT EXECUTE ON FUNCTION public.is_active_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_ai_request_analytics(timestamptz,timestamptz,text,text,text,integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_data_quality_report(text,text,text,text,text,integer,integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_data_quality_report_v2(text,text,text,text,text,text,integer,integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_data_quality_summary() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.remove_data_quality_emails(uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_data_quality_flag_status(text,text,uuid[],text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_hostinger_inbound_receipt(uuid,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_recipient_outreach(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_email_group_quality(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_lead_data_quality(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_recipient_outreach_claim(uuid,text,uuid) TO service_role;

-- Approved invoker report/search RPCs. RLS remains effective inside them.
GRANT EXECUTE ON FUNCTION public.get_dashboard_summary(timestamptz),public.get_deals_search_page(text,integer,integer),public.get_delivery_failure_lead_selection(text,text,text,boolean),public.get_delivery_failure_report(text,text,text,integer,integer),public.get_dm_queue_search_page(text,text,text,text,integer,integer),public.get_email_log_search_page(text,text,text,integer,integer),public.get_email_log_summary(text,text,text),public.get_email_report_leads(text[],text[]),public.get_health_summary(timestamptz),public.get_lead_status_counts(),public.get_leads_search_page(text[],text,text,text,integer,integer,boolean),public.get_lifecycle_page(timestamptz,text,text,text,text,integer,integer),public.get_pipeline_search_page(text[],text,integer,integer) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.suppress_lead_delivery_email(uuid,text) TO service_role;

-- Harden future objects owned by both common migration owners.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC,anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC,anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC,anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC,anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC,anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
