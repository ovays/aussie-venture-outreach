


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "extensions";


ALTER SCHEMA "extensions" OWNER TO "postgres";


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "extensions"."grant_pg_cron_access"() RETURNS "event_trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
  IF EXISTS (
    SELECT
    FROM pg_event_trigger_ddl_commands() AS ev
    JOIN pg_extension AS ext
    ON ev.objid = ext.oid
    WHERE ext.extname = 'pg_cron'
  )
  THEN
    grant usage on schema cron to postgres with grant option;

    alter default privileges in schema cron grant all on tables to postgres with grant option;
    alter default privileges in schema cron grant all on functions to postgres with grant option;
    alter default privileges in schema cron grant all on sequences to postgres with grant option;

    alter default privileges for user supabase_admin in schema cron grant all
        on sequences to postgres with grant option;
    alter default privileges for user supabase_admin in schema cron grant all
        on tables to postgres with grant option;
    alter default privileges for user supabase_admin in schema cron grant all
        on functions to postgres with grant option;

    grant all privileges on all tables in schema cron to postgres with grant option;
    revoke all on table cron.job from postgres;
    grant select on table cron.job to postgres with grant option;
    revoke trigger on cron.job_run_details from postgres;
  END IF;
END;
$$;


ALTER FUNCTION "extensions"."grant_pg_cron_access"() OWNER TO "supabase_admin";


COMMENT ON FUNCTION "extensions"."grant_pg_cron_access"() IS 'Grants access to pg_cron';



CREATE OR REPLACE FUNCTION "extensions"."grant_pg_graphql_access"() RETURNS "event_trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $_$
begin
    if not exists (
        select 1
        from pg_catalog.pg_event_trigger_ddl_commands() ev
        join pg_catalog.pg_extension e on ev.objid = e.oid
        where e.extname = 'pg_graphql'
    ) then
        return;
    end if;

    drop function if exists graphql_public.graphql;
    create or replace function graphql_public.graphql(
        "operationName" text default null,
        query text default null,
        variables jsonb default null,
        extensions jsonb default null
    )
        returns jsonb
        language sql
    as $$
        select graphql.resolve(
            query := query,
            variables := coalesce(variables, '{}'),
            "operationName" := "operationName",
            extensions := extensions
        );
    $$;

    -- Attach the wrapper to the extension so DROP EXTENSION cascades to it,
    -- which in turn triggers set_graphql_placeholder to reinstall the "not enabled" stub.
    alter extension pg_graphql add function graphql_public.graphql(text, text, jsonb, jsonb);

    grant usage on schema graphql to postgres, anon, authenticated, service_role;
    grant execute on function graphql.resolve to postgres, anon, authenticated, service_role;
    grant usage on schema graphql to postgres with grant option;
    grant usage on schema graphql_public to postgres with grant option;
end;
$_$;


ALTER FUNCTION "extensions"."grant_pg_graphql_access"() OWNER TO "supabase_admin";


COMMENT ON FUNCTION "extensions"."grant_pg_graphql_access"() IS 'Grants access to pg_graphql';



CREATE OR REPLACE FUNCTION "extensions"."grant_pg_net_access"() RETURNS "event_trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_event_trigger_ddl_commands() AS ev
    JOIN pg_extension AS ext
    ON ev.objid = ext.oid
    WHERE ext.extname = 'pg_net'
  )
  THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_roles
      WHERE rolname = 'supabase_functions_admin'
    )
    THEN
      CREATE USER supabase_functions_admin NOINHERIT CREATEROLE LOGIN NOREPLICATION;
    END IF;

    GRANT USAGE ON SCHEMA net TO supabase_functions_admin, postgres, anon, authenticated, service_role;

    IF EXISTS (
      SELECT FROM pg_extension
      WHERE extname = 'pg_net'
      -- all versions in use on existing projects as of 2025-02-20
      -- version 0.12.0 onwards don't need these applied
      AND extversion IN ('0.2', '0.6', '0.7', '0.7.1', '0.8.0', '0.10.0', '0.11.0')
    ) THEN
      ALTER function net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) SECURITY DEFINER;
      ALTER function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) SECURITY DEFINER;

      ALTER function net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) SET search_path = net;
      ALTER function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) SET search_path = net;

      REVOKE ALL ON FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) FROM PUBLIC;
      REVOKE ALL ON FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) FROM PUBLIC;

      GRANT EXECUTE ON FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) TO supabase_functions_admin, postgres, anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) TO supabase_functions_admin, postgres, anon, authenticated, service_role;
    END IF;
  END IF;
END;
$$;


ALTER FUNCTION "extensions"."grant_pg_net_access"() OWNER TO "supabase_admin";


COMMENT ON FUNCTION "extensions"."grant_pg_net_access"() IS 'Grants access to pg_net';



CREATE OR REPLACE FUNCTION "extensions"."pgrst_ddl_watch"() RETURNS "event_trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF cmd.command_tag IN (
      'CREATE SCHEMA', 'ALTER SCHEMA'
    , 'CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE'
    , 'CREATE FOREIGN TABLE', 'ALTER FOREIGN TABLE'
    , 'CREATE VIEW', 'ALTER VIEW'
    , 'CREATE MATERIALIZED VIEW', 'ALTER MATERIALIZED VIEW'
    , 'CREATE FUNCTION', 'ALTER FUNCTION'
    , 'CREATE TRIGGER'
    , 'CREATE TYPE', 'ALTER TYPE'
    , 'CREATE RULE'
    , 'COMMENT'
    )
    -- don't notify in case of CREATE TEMP table or other objects created on pg_temp
    AND cmd.schema_name is distinct from 'pg_temp'
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $$;


ALTER FUNCTION "extensions"."pgrst_ddl_watch"() OWNER TO "supabase_admin";


CREATE OR REPLACE FUNCTION "extensions"."pgrst_drop_watch"() RETURNS "event_trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects()
  LOOP
    IF obj.object_type IN (
      'schema'
    , 'table'
    , 'foreign table'
    , 'view'
    , 'materialized view'
    , 'function'
    , 'trigger'
    , 'type'
    , 'rule'
    )
    AND obj.is_temporary IS false -- no pg_temp objects
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $$;


ALTER FUNCTION "extensions"."pgrst_drop_watch"() OWNER TO "supabase_admin";


CREATE OR REPLACE FUNCTION "extensions"."set_graphql_placeholder"() RETURNS "event_trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $_$
    DECLARE
    graphql_is_dropped bool;
    BEGIN
    graphql_is_dropped = (
        SELECT ev.schema_name = 'graphql_public'
        FROM pg_event_trigger_dropped_objects() AS ev
        WHERE ev.schema_name = 'graphql_public'
    );

    IF graphql_is_dropped
    THEN
        create or replace function graphql_public.graphql(
            "operationName" text default null,
            query text default null,
            variables jsonb default null,
            extensions jsonb default null
        )
            returns jsonb
            language plpgsql
            set search_path to ''
        as $$
            DECLARE
                server_version float;
            BEGIN
                server_version = (SELECT (SPLIT_PART((select version()), ' ', 2))::float);

                IF server_version >= 14 THEN
                    RETURN jsonb_build_object(
                        'errors', jsonb_build_array(
                            jsonb_build_object(
                                'message', 'pg_graphql extension is not enabled.'
                            )
                        )
                    );
                ELSE
                    RETURN jsonb_build_object(
                        'errors', jsonb_build_array(
                            jsonb_build_object(
                                'message', 'pg_graphql is only available on projects running Postgres 14 onwards.'
                            )
                        )
                    );
                END IF;
            END;
        $$;
    END IF;

    END;
$_$;


ALTER FUNCTION "extensions"."set_graphql_placeholder"() OWNER TO "supabase_admin";


COMMENT ON FUNCTION "extensions"."set_graphql_placeholder"() IS 'Reintroduces placeholder function for graphql_public.graphql';



CREATE OR REPLACE FUNCTION "public"."claim_hostinger_inbound_receipt"("p_receipt_id" "uuid", "p_run_id" "text", "p_stale_before" timestamp with time zone) RETURNS TABLE("receipt_id" "uuid", "attempt_count" integer)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  UPDATE public.inbound_receipts
  SET status = 'processing',
      processing_run_id = p_run_id,
      processing_started_at = NOW(),
      attempts = attempts + 1,
      last_error = NULL,
      updated_at = NOW()
  WHERE id = p_receipt_id
    AND provider = 'hostinger'
    AND (
      status IN ('pending', 'queued', 'failed')
      OR (
        status = 'processing'
        AND (
          processing_run_id = p_run_id
          OR COALESCE(processing_started_at, updated_at) < p_stale_before
        )
      )
    )
  RETURNING id, attempts;
$$;


ALTER FUNCTION "public"."claim_hostinger_inbound_receipt"("p_receipt_id" "uuid", "p_run_id" "text", "p_stale_before" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_recipient_outreach"("p_lead_id" "uuid", "p_phase" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_email TEXT;
  v_owner UUID;
  v_bad TEXT;
  v_provisional BOOLEAN := false;
  v_claim_token UUID;
BEGIN
  IF p_phase NOT IN ('initial','follow_up','reactivation') THEN RAISE EXCEPTION 'Invalid outreach phase'; END IF;
  SELECT normalized_email INTO v_email FROM leads WHERE id = p_lead_id FOR UPDATE;
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
  WHERE lead_id = p_lead_id AND status = 'open'
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

  -- The advisory transaction lock plus normalized_email primary key makes the
  -- first claim atomic across Writer, automated Sender, and manual send paths.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_email, 734921));
  SELECT owner_lead_id INTO v_owner
  FROM recipient_outreach_ownership
  WHERE normalized_email = v_email
  FOR UPDATE;
  v_provisional := v_owner IS NULL;
  IF v_owner IS NULL THEN
    SELECT l.id INTO v_owner
    FROM leads l
    JOIN emails e ON e.lead_id = l.id AND e.status IN ('sent','email_sync_failed')
    LEFT JOIN deals d ON d.lead_id = l.id
    WHERE l.normalized_email = v_email
    ORDER BY
      CASE WHEN d.id IS NOT NULL OR l.status IN ('replied','negotiating','interested','closed_won','closed','closed_manual') THEN 0 ELSE 1 END,
      e.sent_at ASC NULLS LAST, l.created_at ASC, l.id
    LIMIT 1;
  END IF;
  IF v_owner IS NULL THEN v_owner := p_lead_id; END IF;
  IF v_provisional AND v_owner = p_lead_id THEN v_claim_token := gen_random_uuid(); END IF;

  INSERT INTO recipient_outreach_ownership (normalized_email, owner_lead_id, metadata)
  VALUES (
    v_email,
    v_owner,
    jsonb_build_object('source', 'claim', 'phase', p_phase)
      || CASE WHEN v_claim_token IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('claim_token', v_claim_token) END
  )
  ON CONFLICT (normalized_email) DO UPDATE SET
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
  WHERE normalized_email = v_email;

  INSERT INTO lead_data_quality_flags (lead_id, normalized_email, issue_type, reason, related_lead_ids, metadata)
  SELECT l.id, v_email, 'already_contacted_email',
    'Another lead owns the active outreach lifecycle for this recipient.',
    ARRAY[v_owner], jsonb_build_object('owner_lead_id', v_owner, 'phase', p_phase)
  FROM leads l
  WHERE l.normalized_email = v_email AND l.id <> v_owner
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
    INSERT INTO lead_data_quality_flags (lead_id, normalized_email, issue_type, reason, related_lead_ids, metadata)
    VALUES (
      p_lead_id, v_email, 'already_contacted_email',
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
END;
$$;


ALTER FUNCTION "public"."claim_recipient_outreach"("p_lead_id" "uuid", "p_phase" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."classify_data_quality_group"("p_leads" "jsonb") RETURNS "jsonb"
    LANGUAGE "sql" IMMUTABLE PARALLEL SAFE
    AS $$
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


ALTER FUNCTION "public"."classify_data_quality_group"("p_leads" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."classify_email_quality"("p_email" "text") RETURNS TABLE("issue_type" "text", "reason" "text")
    LANGUAGE "plpgsql" IMMUTABLE
    AS $_$
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
$_$;


ALTER FUNCTION "public"."classify_email_quality"("p_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."clear_lead_outreach_suppression_on_email_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_bad TEXT;
BEGIN
  IF NULLIF(lower(btrim(OLD.email)), '') IS DISTINCT FROM NULLIF(lower(btrim(NEW.email)), '') THEN
    SELECT q.issue_type INTO v_bad
    FROM public.classify_email_quality(NEW.email) q
    LIMIT 1;
    UPDATE leads
    SET outreach_suppression_reason = v_bad,
        outreach_suppressed_at = CASE WHEN v_bad IS NULL THEN NULL ELSE COALESCE(outreach_suppressed_at, now()) END
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."clear_lead_outreach_suppression_on_email_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."data_quality_compact_identity"("p_value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT NULLIF(regexp_replace(lower(public.data_quality_present(p_value)),'[^a-z0-9]+','','g'),'')
$$;


ALTER FUNCTION "public"."data_quality_compact_identity"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."data_quality_meaningful_website_identity"("p_value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE WHEN position('/' IN public.data_quality_website_identity(p_value)) > 0
    THEN public.data_quality_website_identity(p_value) ELSE NULL END
$$;


ALTER FUNCTION "public"."data_quality_meaningful_website_identity"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."data_quality_phone_identity"("p_value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT NULLIF(regexp_replace(public.data_quality_present(p_value),'[^0-9]+','','g'),'')
$$;


ALTER FUNCTION "public"."data_quality_phone_identity"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."data_quality_present"("p_value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE
    WHEN NULLIF(btrim(p_value),'') IS NULL THEN NULL
    WHEN lower(btrim(p_value)) = ANY (ARRAY[
      'not found','not mentioned','not available','unknown','n/a','-'
    ]) THEN NULL
    ELSE btrim(p_value)
  END
$$;


ALTER FUNCTION "public"."data_quality_present"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."data_quality_social_identity"("p_value" "text") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE PARALLEL SAFE
    AS $_$
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
$_$;


ALTER FUNCTION "public"."data_quality_social_identity"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."data_quality_website_identity"("p_value" "text") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE PARALLEL SAFE
    AS $_$
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
$_$;


ALTER FUNCTION "public"."data_quality_website_identity"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_ai_request_analytics"("p_start_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_end_at" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_workflow" "text" DEFAULT NULL::"text", "p_provider" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_recent_limit" integer DEFAULT 50) RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  WITH filtered AS MATERIALIZED (
    SELECT *
    FROM public.ai_request_logs
    WHERE (auth.role() = 'service_role' OR public.is_active_admin())
      AND (p_start_at IS NULL OR created_at >= p_start_at)
      AND (p_end_at IS NULL OR created_at < p_end_at)
      AND (p_workflow IS NULL OR workflow = p_workflow)
      AND (p_provider IS NULL OR provider = p_provider)
      AND (p_status IS NULL OR status = p_status)
  ),
  summary AS (
    SELECT
      count(*) AS total_requests,
      count(*) FILTER (WHERE status = 'succeeded') AS successful_requests,
      count(*) FILTER (WHERE status = 'failed') AS failed_requests,
      avg(duration_ms) AS average_latency_ms,
      avg(estimated_cost_usd) AS average_cost_usd,
      count(*) FILTER (
        WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Australia/Sydney')
          AT TIME ZONE 'Australia/Sydney'
      ) AS requests_today,
      count(*) FILTER (
        WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Australia/Sydney')
          AT TIME ZONE 'Australia/Sydney'
      ) AS requests_this_month
    FROM filtered
  )
  SELECT jsonb_build_object(
    'summary', jsonb_build_object(
      'totalRequests', summary.total_requests,
      'successfulRequests', summary.successful_requests,
      'failedRequests', summary.failed_requests,
      'successRate', CASE
        WHEN summary.total_requests = 0 THEN 0
        ELSE round(summary.successful_requests::numeric * 100 / summary.total_requests, 2)
      END,
      'averageLatencyMs', round(COALESCE(summary.average_latency_ms, 0), 2),
      'averageCostUsd', CASE
        WHEN summary.average_cost_usd IS NULL THEN NULL
        ELSE round(summary.average_cost_usd, 8)
      END,
      'requestsToday', summary.requests_today,
      'requestsThisMonth', summary.requests_this_month
    ),
    'topWorkflows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', workflow, 'count', request_count))
      FROM (
        SELECT workflow, count(*) AS request_count
        FROM filtered GROUP BY workflow
        ORDER BY request_count DESC, workflow LIMIT 10
      ) ranked
    ), '[]'::jsonb),
    'topModels', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', model, 'count', request_count))
      FROM (
        SELECT model, count(*) AS request_count
        FROM filtered WHERE model IS NOT NULL GROUP BY model
        ORDER BY request_count DESC, model LIMIT 10
      ) ranked
    ), '[]'::jsonb),
    'topProviders', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', provider, 'count', request_count))
      FROM (
        SELECT provider, count(*) AS request_count
        FROM filtered WHERE provider IS NOT NULL GROUP BY provider
        ORDER BY request_count DESC, provider LIMIT 10
      ) ranked
    ), '[]'::jsonb),
    'recentRequests', COALESCE((
      SELECT jsonb_agg(to_jsonb(recent))
      FROM (
        SELECT
          id,
          created_at AS "createdAt",
          workflow,
          provider,
          model,
          status,
          duration_ms AS "durationMs",
          input_tokens AS "inputTokens",
          output_tokens AS "outputTokens",
          total_tokens AS "totalTokens",
          estimated_cost_usd AS "estimatedCostUsd",
          error_message AS "errorMessage",
          retry_count AS "retryCount",
          request_source AS "requestSource"
        FROM filtered
        ORDER BY created_at DESC
        LIMIT LEAST(GREATEST(p_recent_limit, 1), 100)
      ) recent
    ), '[]'::jsonb)
  )
  FROM summary;
$$;


ALTER FUNCTION "public"."get_ai_request_analytics"("p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_workflow" "text", "p_provider" "text", "p_status" "text", "p_recent_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_dashboard_summary"("p_as_of" timestamp with time zone DEFAULT "now"()) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog'
    AS $$
WITH
params AS (
  SELECT
    p_as_of AS as_of,
    (p_as_of AT TIME ZONE 'Australia/Sydney')::DATE AS sydney_date,
    ((p_as_of AT TIME ZONE 'Australia/Sydney')::DATE::TIMESTAMP AT TIME ZONE 'Australia/Sydney') AS today_start,
    ((((p_as_of AT TIME ZONE 'Australia/Sydney')::DATE + 1)::TIMESTAMP) AT TIME ZONE 'Australia/Sydney') AS today_end
),
settings_raw AS (
  SELECT
    MAX(settings.value) FILTER (WHERE settings.key = 'follow_up_1_days') AS follow_up_1_days,
    MAX(settings.value) FILTER (WHERE settings.key = 'follow_up_2_days') AS follow_up_2_days,
    MAX(settings.value) FILTER (WHERE settings.key = 'follow_up_3_days') AS follow_up_3_days,
    MAX(settings.value) FILTER (WHERE settings.key = 'reactivation_delay_days') AS reactivation_delay_days,
    MAX(settings.value) FILTER (WHERE settings.key = 'dead_after_reactivation_days') AS dead_after_reactivation_days,
    MAX(settings.value) FILTER (WHERE settings.key = 'reactivation_enabled') AS reactivation_enabled
  FROM public.settings AS settings
  WHERE settings.key IN (
    'follow_up_1_days',
    'follow_up_2_days',
    'follow_up_3_days',
    'reactivation_delay_days',
    'dead_after_reactivation_days',
    'reactivation_enabled'
  )
),
settings_values AS (
  SELECT
    COALESCE((SUBSTRING(settings_raw.follow_up_1_days FROM '^[+-]?[0-9]+'))::INTEGER, 7) AS follow_up_1_days,
    COALESCE((SUBSTRING(settings_raw.follow_up_2_days FROM '^[+-]?[0-9]+'))::INTEGER, 14) AS follow_up_2_days,
    COALESCE((SUBSTRING(settings_raw.follow_up_3_days FROM '^[+-]?[0-9]+'))::INTEGER, 21) AS follow_up_3_days,
    COALESCE((SUBSTRING(settings_raw.reactivation_delay_days FROM '^[+-]?[0-9]+'))::INTEGER, 60) AS reactivation_delay_days,
    COALESCE((SUBSTRING(settings_raw.dead_after_reactivation_days FROM '^[+-]?[0-9]+'))::INTEGER, 14) AS dead_after_reactivation_days,
    COALESCE(settings_raw.reactivation_enabled = 'true', FALSE) AS reactivation_enabled
  FROM settings_raw
),
status_grouped AS (
  SELECT leads.status::TEXT AS status, COUNT(*)::BIGINT AS count
  FROM public.leads AS leads
  GROUP BY leads.status
),
status_summary AS (
  SELECT
    COALESCE(pg_catalog.jsonb_object_agg(status_grouped.status, status_grouped.count) FILTER (
      WHERE status_grouped.status IS NOT NULL
    ), '{}'::JSONB) AS counts,
    COALESCE(SUM(status_grouped.count), 0)::BIGINT AS all_leads,
    COALESCE(SUM(status_grouped.count) FILTER (
      WHERE status_grouped.status IN ('contacted', 'replied', 'negotiating', 'interested', 'closed', 'closed_won', 'closed_manual', 'dead')
    ), 0)::BIGINT AS total_contacted,
    COALESCE(SUM(status_grouped.count) FILTER (
      WHERE status_grouped.status IN ('replied', 'negotiating', 'interested', 'closed', 'closed_won', 'closed_manual')
    ), 0)::BIGINT AS positive_replies
  FROM status_grouped
),
email_metrics AS (
  SELECT
    COUNT(*) FILTER (
      WHERE emails.status = 'sent'
        AND emails.sent_at >= params.today_start
        AND emails.sent_at < params.today_end
    )::BIGINT AS sent_today,
    COUNT(*) FILTER (
      WHERE emails.status = 'sent'
        AND emails.type = 'initial_pitch'
        AND emails.sent_at >= params.today_start
        AND emails.sent_at < params.today_end
    )::BIGINT AS initial_sent_today,
    COUNT(*) FILTER (
      WHERE emails.status = 'sent'
        AND emails.type = 'follow_up_1'
        AND emails.sent_at >= params.today_start
        AND emails.sent_at < params.today_end
    )::BIGINT AS follow_up_1_sent_today,
    COUNT(*) FILTER (
      WHERE emails.status = 'sent'
        AND emails.type = 'follow_up_2'
        AND emails.sent_at >= params.today_start
        AND emails.sent_at < params.today_end
    )::BIGINT AS follow_up_2_sent_today,
    COUNT(*) FILTER (
      WHERE emails.status = 'sent'
        AND emails.type = 'follow_up_3'
        AND emails.sent_at >= params.today_start
        AND emails.sent_at < params.today_end
    )::BIGINT AS follow_up_3_sent_today,
    COUNT(*) FILTER (
      WHERE emails.status = 'sent'
        AND emails.type IN ('follow_up_1', 'follow_up_2', 'follow_up_3')
    )::BIGINT AS followups_sent_total,
    COUNT(*) FILTER (
      WHERE emails.replied_at IS NOT NULL
        AND emails.replied_at >= params.today_start
        AND emails.replied_at < params.today_end
    )::BIGINT AS replies_today,
    COUNT(*) FILTER (
      WHERE emails.status = 'sent'
        AND emails.sent_at >= ((((params.sydney_date - 6)::TIMESTAMP) AT TIME ZONE 'Australia/Sydney'))
        AND emails.sent_at < params.today_end
    )::BIGINT AS emails_sent_this_week
  FROM public.emails AS emails
  CROSS JOIN params
),
contacted_email_events AS MATERIALIZED (
  SELECT
    leads.id AS lead_id,
    (ARRAY_AGG(emails.sent_at ORDER BY emails.created_at, emails.id) FILTER (
      WHERE emails.type = 'initial_pitch' AND emails.sent_at IS NOT NULL
    ))[1] AS initial_sent_at,
    COALESCE(BOOL_OR(emails.sent_at IS NOT NULL) FILTER (WHERE emails.type = 'follow_up_1'), FALSE) AS follow_up_1_sent,
    COALESCE(BOOL_OR(emails.sent_at IS NOT NULL) FILTER (WHERE emails.type = 'follow_up_2'), FALSE) AS follow_up_2_sent,
    COALESCE(BOOL_OR(emails.sent_at IS NOT NULL) FILTER (WHERE emails.type = 'follow_up_3'), FALSE) AS follow_up_3_sent
  FROM public.leads AS leads
  LEFT JOIN public.emails AS emails ON emails.lead_id = leads.id
  WHERE leads.status = 'contacted'
    AND leads.email IS NOT NULL
    AND leads.email <> ''
  GROUP BY leads.id
),
contacted_eligibility AS (
  SELECT
    leads.id AS lead_id,
    leads.reactivation_sent_at,
    contacted_email_events.initial_sent_at,
    contacted_email_events.follow_up_1_sent,
    contacted_email_events.follow_up_2_sent,
    contacted_email_events.follow_up_3_sent,
    FLOOR(EXTRACT(EPOCH FROM (params.as_of - contacted_email_events.initial_sent_at)) / 86400)::INTEGER AS days_since_initial,
    CASE
      WHEN leads.reactivation_sent_at IS NULL THEN NULL
      ELSE FLOOR(EXTRACT(EPOCH FROM (params.as_of - leads.reactivation_sent_at)) / 86400)::INTEGER
    END AS days_since_reactivation,
    CASE
      WHEN NOT contacted_email_events.follow_up_1_sent THEN 'follow_up_1'
      WHEN NOT contacted_email_events.follow_up_2_sent THEN 'follow_up_2'
      WHEN NOT contacted_email_events.follow_up_3_sent THEN 'follow_up_3'
      ELSE NULL
    END AS next_follow_up
  FROM contacted_email_events
  JOIN public.leads AS leads ON leads.id = contacted_email_events.lead_id
  CROSS JOIN params
  WHERE contacted_email_events.initial_sent_at IS NOT NULL
),
followup_summary AS (
  SELECT
    COUNT(*) FILTER (
      WHERE contacted_eligibility.next_follow_up = 'follow_up_1'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_1_days
    )::BIGINT AS pending_follow_up_1,
    COUNT(*) FILTER (
      WHERE contacted_eligibility.next_follow_up = 'follow_up_2'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_2_days
    )::BIGINT AS pending_follow_up_2,
    COUNT(*) FILTER (
      WHERE contacted_eligibility.next_follow_up = 'follow_up_3'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_3_days
    )::BIGINT AS pending_follow_up_3,
    COUNT(*) FILTER (
      WHERE contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up = 'follow_up_1'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_1_days
    )::BIGINT AS follow_up_1_due,
    COUNT(*) FILTER (
      WHERE contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up = 'follow_up_2'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_2_days
    )::BIGINT AS follow_up_2_due,
    COUNT(*) FILTER (
      WHERE contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up = 'follow_up_3'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_3_days
    )::BIGINT AS follow_up_3_due,
    COUNT(*) FILTER (
      WHERE contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up IS NULL
        AND settings_values.reactivation_enabled
      OR contacted_eligibility.reactivation_sent_at IS NOT NULL
        AND contacted_eligibility.days_since_reactivation < settings_values.dead_after_reactivation_days
    )::BIGINT AS reactivation_total,
    COUNT(*) FILTER (
      WHERE contacted_eligibility.reactivation_sent_at IS NOT NULL
        AND contacted_eligibility.days_since_reactivation >= settings_values.dead_after_reactivation_days
      OR contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up = 'follow_up_3'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_3_days
      OR contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up = 'follow_up_2'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_2_days
      OR contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up = 'follow_up_1'
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_1_days
      OR contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up IS NULL
        AND settings_values.reactivation_enabled
        AND contacted_eligibility.days_since_initial >= settings_values.reactivation_delay_days
      OR contacted_eligibility.reactivation_sent_at IS NULL
        AND contacted_eligibility.next_follow_up IS NULL
        AND NOT settings_values.reactivation_enabled
        AND contacted_eligibility.days_since_initial >= settings_values.follow_up_3_days
    )::BIGINT AS overdue_total
  FROM contacted_eligibility
  CROSS JOIN settings_values
),
daily_days AS (
  SELECT
    offsets.days_back,
    (params.sydney_date - offsets.days_back)::DATE AS activity_date,
    ((((params.sydney_date - offsets.days_back)::DATE)::TIMESTAMP) AT TIME ZONE 'Australia/Sydney') AS day_start,
    (((((params.sydney_date - offsets.days_back)::DATE) + 1)::TIMESTAMP) AT TIME ZONE 'Australia/Sydney') AS day_end
  FROM params
  CROSS JOIN pg_catalog.generate_series(0, 6) AS offsets(days_back)
),
daily_leads AS (
  SELECT
    (leads.created_at AT TIME ZONE 'Australia/Sydney')::DATE AS activity_date,
    COUNT(*)::BIGINT AS count
  FROM public.leads AS leads
  CROSS JOIN params
  WHERE leads.created_at >= ((((params.sydney_date - 6)::DATE)::TIMESTAMP) AT TIME ZONE 'Australia/Sydney')
    AND leads.created_at < params.today_end
  GROUP BY (leads.created_at AT TIME ZONE 'Australia/Sydney')::DATE
),
daily_emails AS (
  SELECT
    (emails.sent_at AT TIME ZONE 'Australia/Sydney')::DATE AS activity_date,
    COUNT(*)::BIGINT AS emails_sent,
    COUNT(*) FILTER (WHERE emails.type IN ('follow_up_1', 'follow_up_2', 'follow_up_3'))::BIGINT AS followups_sent
  FROM public.emails AS emails
  CROSS JOIN params
  WHERE emails.status = 'sent'
    AND emails.sent_at >= ((((params.sydney_date - 6)::DATE)::TIMESTAMP) AT TIME ZONE 'Australia/Sydney')
    AND emails.sent_at < params.today_end
  GROUP BY (emails.sent_at AT TIME ZONE 'Australia/Sydney')::DATE
),
daily_dms AS (
  SELECT
    (dm_queue.created_at AT TIME ZONE 'Australia/Sydney')::DATE AS activity_date,
    COUNT(*)::BIGINT AS count
  FROM public.dm_queue AS dm_queue
  CROSS JOIN params
  WHERE dm_queue.created_at >= ((((params.sydney_date - 6)::DATE)::TIMESTAMP) AT TIME ZONE 'Australia/Sydney')
    AND dm_queue.created_at < params.today_end
  GROUP BY (dm_queue.created_at AT TIME ZONE 'Australia/Sydney')::DATE
),
daily_activity AS (
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'date', daily_days.activity_date::TEXT,
        'label', CASE
          WHEN daily_days.days_back = 0 THEN 'Today (' || pg_catalog.to_char(daily_days.activity_date, 'FMDD Mon') || ')'
          WHEN daily_days.days_back = 1 THEN 'Yesterday (' || pg_catalog.to_char(daily_days.activity_date, 'FMDD Mon') || ')'
          ELSE pg_catalog.to_char(daily_days.activity_date, 'FMDD Mon')
        END,
        'leads_found', COALESCE(daily_leads.count, 0),
        'emails_sent', COALESCE(daily_emails.emails_sent, 0),
        'dms_queued', COALESCE(daily_dms.count, 0),
        'followups_sent', COALESCE(daily_emails.followups_sent, 0)
      ) ORDER BY daily_days.days_back
    ),
    '[]'::JSONB
  ) AS rows
  FROM daily_days
  LEFT JOIN daily_leads ON daily_leads.activity_date = daily_days.activity_date
  LEFT JOIN daily_emails ON daily_emails.activity_date = daily_days.activity_date
  LEFT JOIN daily_dms ON daily_dms.activity_date = daily_days.activity_date
),
dm_summary AS (
  SELECT
    COUNT(*) FILTER (
      WHERE dm_queue.status = 'sent'
        AND dm_queue.sent_at >= params.today_start
        AND dm_queue.sent_at < params.today_end
    )::BIGINT AS sent_today,
    COUNT(*) FILTER (WHERE dm_queue.status = 'pending')::BIGINT AS queued
  FROM public.dm_queue AS dm_queue
  CROSS JOIN params
),
deal_windows AS (
  SELECT
    weeks.week_number,
    params.as_of - ((13 - weeks.week_number) * INTERVAL '7 days') AS week_start,
    params.as_of - ((12 - weeks.week_number) * INTERVAL '7 days') AS week_end
  FROM params
  CROSS JOIN pg_catalog.generate_series(1, 12) AS weeks(week_number)
),
deal_summary AS (
  SELECT COUNT(*)::BIGINT AS rolling_30_day_count
  FROM public.deals AS deals
  CROSS JOIN params
  WHERE deals.closed_at >= params.as_of - INTERVAL '30 days'
),
weekly_revenue AS (
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'week', 'W' || deal_windows.week_number::TEXT,
        'revenue', COALESCE(revenue.revenue, 0)
      ) ORDER BY deal_windows.week_number
    ),
    '[]'::JSONB
  ) AS rows
  FROM deal_windows
  LEFT JOIN LATERAL (
    SELECT SUM(deals.deal_value) AS revenue
    FROM public.deals AS deals
    WHERE deals.closed_at >= deal_windows.week_start
      AND deals.closed_at < deal_windows.week_end
  ) AS revenue ON TRUE
),
recent_activity AS (
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', bounded_activity.id,
        'event_type', bounded_activity.event_type,
        'description', bounded_activity.description,
        'created_at', bounded_activity.created_at
      ) ORDER BY bounded_activity.created_at DESC
    ),
    '[]'::JSONB
  ) AS rows
  FROM (
    SELECT activity_log.id, activity_log.event_type, activity_log.description, activity_log.created_at
    FROM public.activity_log AS activity_log
    ORDER BY activity_log.created_at DESC
    LIMIT 20
  ) AS bounded_activity
),
hot_lead_selection AS MATERIALIZED (
  SELECT leads.id, leads.business_name, leads.city, leads.status, leads.created_at
  FROM public.leads AS leads
  WHERE leads.status IN ('replied', 'negotiating', 'interested')
  ORDER BY leads.created_at DESC
  LIMIT 10
),
hot_lead_emails AS (
  SELECT
    hot_lead_selection.id AS lead_id,
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'type', emails.type,
          'sent_at', emails.sent_at,
          'replied_at', emails.replied_at,
          'subject', emails.subject
        ) ORDER BY emails.created_at, emails.id
      ) FILTER (WHERE emails.id IS NOT NULL),
      '[]'::JSONB
    ) AS emails
  FROM hot_lead_selection
  LEFT JOIN public.emails AS emails ON emails.lead_id = hot_lead_selection.id
  GROUP BY hot_lead_selection.id
),
hot_leads AS (
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', hot_lead_selection.id,
        'business_name', hot_lead_selection.business_name,
        'city', hot_lead_selection.city,
        'status', hot_lead_selection.status,
        'emails', hot_lead_emails.emails
      ) ORDER BY
        CASE hot_lead_selection.status
          WHEN 'replied' THEN 1
          WHEN 'negotiating' THEN 2
          WHEN 'interested' THEN 3
          ELSE 4
        END,
        hot_lead_selection.created_at DESC
    ),
    '[]'::JSONB
  ) AS rows
  FROM hot_lead_selection
  JOIN hot_lead_emails ON hot_lead_emails.lead_id = hot_lead_selection.id
)
SELECT pg_catalog.jsonb_build_object(
  'as_of', params.as_of,
  'today_range', pg_catalog.jsonb_build_object(
    'timezone', 'Australia/Sydney',
    'start', params.today_start,
    'end', params.today_end,
    'date_key', params.sydney_date::TEXT
  ),
  'status_counts', status_summary.counts,
  'today_email_stats', pg_catalog.jsonb_build_object(
    'total_sent', email_metrics.sent_today,
    'initial_sent', email_metrics.initial_sent_today,
    'followups_sent', email_metrics.follow_up_1_sent_today + email_metrics.follow_up_2_sent_today + email_metrics.follow_up_3_sent_today,
    'follow_up_1_sent', email_metrics.follow_up_1_sent_today,
    'follow_up_2_sent', email_metrics.follow_up_2_sent_today,
    'follow_up_3_sent', email_metrics.follow_up_3_sent_today
  ),
  'today_dm_stats', pg_catalog.jsonb_build_object('sent_today', dm_summary.sent_today),
  'reply_stats', pg_catalog.jsonb_build_object(
    'total_contacted_leads', status_summary.total_contacted,
    'positive_response_leads', status_summary.positive_replies,
    'replies_today', email_metrics.replies_today,
    'reply_rate', CASE
      WHEN status_summary.total_contacted > 0
        THEN pg_catalog.round((status_summary.positive_replies::NUMERIC / status_summary.total_contacted::NUMERIC) * 100)::INTEGER
      ELSE 0
    END
  ),
  'followup_stats', pg_catalog.jsonb_build_object(
    'sent_today', email_metrics.follow_up_1_sent_today + email_metrics.follow_up_2_sent_today + email_metrics.follow_up_3_sent_today,
    'total_sent', email_metrics.followups_sent_total,
    'pending', followup_summary.pending_follow_up_1 + followup_summary.pending_follow_up_2 + followup_summary.pending_follow_up_3,
    'follow_up_1_sent_today', email_metrics.follow_up_1_sent_today,
    'follow_up_2_sent_today', email_metrics.follow_up_2_sent_today,
    'follow_up_3_sent_today', email_metrics.follow_up_3_sent_today,
    'pending_follow_up_1', followup_summary.pending_follow_up_1,
    'pending_follow_up_2', followup_summary.pending_follow_up_2,
    'pending_follow_up_3', followup_summary.pending_follow_up_3,
    'fu1_due', followup_summary.follow_up_1_due,
    'fu2_due', followup_summary.follow_up_2_due,
    'fu3_due', followup_summary.follow_up_3_due,
    'fu_due', followup_summary.follow_up_1_due + followup_summary.follow_up_2_due + followup_summary.follow_up_3_due,
    'reactivation_total', followup_summary.reactivation_total,
    'overdue_total', followup_summary.overdue_total
  ),
  'daily_activity', daily_activity.rows,
  'emails_sent_this_week', email_metrics.emails_sent_this_week,
  'dms_queued', dm_summary.queued,
  'deals_rolling_30_days', deal_summary.rolling_30_day_count,
  'weekly_revenue', weekly_revenue.rows,
  'recent_activity', recent_activity.rows,
  'hot_leads', hot_leads.rows
)
FROM params
CROSS JOIN status_summary
CROSS JOIN email_metrics
CROSS JOIN followup_summary
CROSS JOIN daily_activity
CROSS JOIN dm_summary
CROSS JOIN deal_summary
CROSS JOIN weekly_revenue
CROSS JOIN recent_activity
CROSS JOIN hot_leads;
$$;


ALTER FUNCTION "public"."get_dashboard_summary"("p_as_of" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_data_quality_report"("p_issue_type" "text" DEFAULT NULL::"text", "p_email" "text" DEFAULT NULL::"text", "p_business" "text" DEFAULT NULL::"text", "p_category" "text" DEFAULT NULL::"text", "p_city" "text" DEFAULT NULL::"text", "p_page" integer DEFAULT 1, "p_page_size" integer DEFAULT 50) RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
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
$_$;


ALTER FUNCTION "public"."get_data_quality_report"("p_issue_type" "text", "p_email" "text", "p_business" "text", "p_category" "text", "p_city" "text", "p_page" integer, "p_page_size" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_data_quality_report_v2"("p_issue_type" "text" DEFAULT NULL::"text", "p_search" "text" DEFAULT NULL::"text", "p_email" "text" DEFAULT NULL::"text", "p_business" "text" DEFAULT NULL::"text", "p_category" "text" DEFAULT NULL::"text", "p_city" "text" DEFAULT NULL::"text", "p_page" integer DEFAULT 1, "p_page_size" integer DEFAULT 50) RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."get_data_quality_report_v2"("p_issue_type" "text", "p_search" "text", "p_email" "text", "p_business" "text", "p_category" "text", "p_city" "text", "p_page" integer, "p_page_size" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_data_quality_summary"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."get_data_quality_summary"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_deals_search_page"("p_search" "text" DEFAULT ''::"text", "p_page" integer DEFAULT 1, "p_page_size" integer DEFAULT 50) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog'
    AS $$
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
$$;


ALTER FUNCTION "public"."get_deals_search_page"("p_search" "text", "p_page" integer, "p_page_size" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_delivery_failure_lead_selection"("p_status" "text" DEFAULT NULL::"text", "p_email_type" "text" DEFAULT NULL::"text", "p_search" "text" DEFAULT ''::"text", "p_include_ids" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog'
    AS $$
WITH
validated AS (
  SELECT
    CASE WHEN p_status IN ('bounced', 'failed', 'suppressed') THEN p_status ELSE NULL END AS status_filter,
    CASE WHEN p_email_type IN ('initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'reactivation') THEN p_email_type ELSE NULL END AS type_filter,
    pg_catalog.btrim(COALESCE(p_search, '')) AS search_term
),
eligible AS MATERIALIZED (
  SELECT emails.lead_id
  FROM public.emails AS emails
  JOIN public.leads AS leads ON leads.id = emails.lead_id
  LEFT JOIN LATERAL (
    SELECT activity_log.metadata
    FROM public.activity_log AS activity_log
    WHERE activity_log.event_type = 'delivery_terminal_failure'
      AND activity_log.metadata ->> 'email_id' = emails.id::TEXT
      AND COALESCE(
        activity_log.metadata ->> 'persisted_status',
        activity_log.metadata ->> 'provider_status'
      ) = emails.status
    ORDER BY activity_log.created_at DESC, activity_log.id DESC
    LIMIT 1
  ) AS provider_event ON TRUE
  CROSS JOIN validated
  WHERE emails.status IN ('bounced', 'failed', 'suppressed')
    AND (validated.status_filter IS NULL OR emails.status = validated.status_filter)
    AND (validated.type_filter IS NULL OR emails.type = validated.type_filter)
    AND (
      validated.search_term = ''
      OR COALESCE(leads.business_name, '') ILIKE '%' || validated.search_term || '%'
      OR COALESCE(NULLIF(provider_event.metadata ->> 'recipient', ''), leads.email, '')
        ILIKE '%' || validated.search_term || '%'
    )
),
unique_leads AS (
  SELECT DISTINCT eligible.lead_id
  FROM eligible
)
SELECT pg_catalog.jsonb_build_object(
  'count', COUNT(*),
  'lead_ids', CASE
    WHEN p_include_ids THEN COALESCE(
      pg_catalog.jsonb_agg(unique_leads.lead_id ORDER BY unique_leads.lead_id),
      '[]'::JSONB
    )
    ELSE '[]'::JSONB
  END
)
FROM unique_leads;
$$;


ALTER FUNCTION "public"."get_delivery_failure_lead_selection"("p_status" "text", "p_email_type" "text", "p_search" "text", "p_include_ids" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_delivery_failure_report"("p_status" "text" DEFAULT NULL::"text", "p_email_type" "text" DEFAULT NULL::"text", "p_search" "text" DEFAULT ''::"text", "p_page" integer DEFAULT 1, "p_page_size" integer DEFAULT 50) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog'
    AS $$
WITH
validated AS (
  SELECT
    CASE WHEN p_status IN ('bounced', 'failed', 'suppressed') THEN p_status ELSE NULL END AS status_filter,
    CASE WHEN p_email_type IN ('initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'reactivation') THEN p_email_type ELSE NULL END AS type_filter,
    pg_catalog.btrim(COALESCE(p_search, '')) AS search_term,
    GREATEST(COALESCE(p_page, 1), 1) AS page_number,
    LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 100) AS page_size
),
current_failures AS MATERIALIZED (
  SELECT
    emails.id::TEXT AS email_id,
    emails.lead_id,
    emails.type AS email_type,
    emails.status AS failure_status,
    emails.resend_id,
    COALESCE(provider_event.created_at, emails.sent_at, emails.created_at) AS failure_date,
    provider_event.metadata AS failure_metadata,
    leads.business_name,
    leads.category_name,
    leads.city,
    leads.email AS current_email,
    COALESCE(NULLIF(provider_event.metadata ->> 'recipient', ''), leads.email) AS recipient,
    provider_event.id IS NOT NULL AS has_provider_event
  FROM public.emails AS emails
  LEFT JOIN public.leads AS leads ON leads.id = emails.lead_id
  LEFT JOIN LATERAL (
    SELECT activity_log.id, activity_log.created_at, activity_log.metadata
    FROM public.activity_log AS activity_log
    WHERE activity_log.event_type = 'delivery_terminal_failure'
      AND activity_log.metadata ->> 'email_id' = emails.id::TEXT
      AND COALESCE(
        activity_log.metadata ->> 'persisted_status',
        activity_log.metadata ->> 'provider_status'
      ) = emails.status
    ORDER BY activity_log.created_at DESC, activity_log.id DESC
    LIMIT 1
  ) AS provider_event ON TRUE
  WHERE emails.status IN ('bounced', 'failed', 'suppressed')
),
historical_provider_events AS MATERIALIZED (
  -- Prompt 1 makes terminal states absorbing, so the first provider terminal
  -- event is the status that was persisted. Collapse webhook retries and any
  -- later weaker terminal event to one historical row per email.
  SELECT DISTINCT ON (activity_log.metadata ->> 'email_id')
    activity_log.id,
    activity_log.created_at,
    activity_log.metadata
  FROM public.activity_log AS activity_log
  WHERE activity_log.event_type = 'delivery_terminal_failure'
    AND activity_log.lead_id IS NULL
    AND activity_log.metadata ->> 'email_id' IS NOT NULL
    AND activity_log.metadata ->> 'provider_status' IN ('bounced', 'failed', 'suppressed')
    AND activity_log.metadata ->> 'email_type' IN ('initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'reactivation')
    AND NOT EXISTS (
      SELECT 1
      FROM public.emails AS emails
      WHERE emails.id::TEXT = activity_log.metadata ->> 'email_id'
    )
  ORDER BY
    activity_log.metadata ->> 'email_id',
    activity_log.created_at ASC,
    activity_log.id ASC
),
historical_failures AS MATERIALIZED (
  SELECT
    historical_provider_events.metadata ->> 'email_id' AS email_id,
    NULL::UUID AS lead_id,
    historical_provider_events.metadata ->> 'email_type' AS email_type,
    COALESCE(
      historical_provider_events.metadata ->> 'persisted_status',
      historical_provider_events.metadata ->> 'provider_status'
    ) AS failure_status,
    historical_provider_events.metadata ->> 'resend_id' AS resend_id,
    historical_provider_events.created_at AS failure_date,
    historical_provider_events.metadata AS failure_metadata,
    NULL::TEXT AS business_name,
    NULL::TEXT AS category_name,
    NULL::TEXT AS city,
    NULL::TEXT AS current_email,
    NULLIF(historical_provider_events.metadata ->> 'recipient', '') AS recipient,
    TRUE AS has_provider_event
  FROM historical_provider_events
),
all_failures AS MATERIALIZED (
  SELECT * FROM current_failures
  UNION ALL
  SELECT * FROM historical_failures
),
failures AS MATERIALIZED (
  SELECT all_failures.*
  FROM all_failures
  CROSS JOIN validated
  WHERE (validated.status_filter IS NULL OR all_failures.failure_status = validated.status_filter)
    AND (validated.type_filter IS NULL OR all_failures.email_type = validated.type_filter)
    AND (
      validated.search_term = ''
      OR COALESCE(all_failures.business_name, '') ILIKE '%' || validated.search_term || '%'
      OR COALESCE(all_failures.recipient, '') ILIKE '%' || validated.search_term || '%'
    )
),
summary AS (
  SELECT
    COUNT(*)::BIGINT AS total,
    COUNT(*) FILTER (WHERE failure_status = 'bounced')::BIGINT AS bounced,
    COUNT(*) FILTER (WHERE failure_status = 'failed')::BIGINT AS failed,
    COUNT(*) FILTER (WHERE failure_status = 'suppressed')::BIGINT AS suppressed
  FROM failures
),
paged AS (
  SELECT failures.*
  FROM failures
  ORDER BY failures.failure_date DESC, failures.email_id ASC
  OFFSET (SELECT (page_number - 1) * page_size FROM validated)
  LIMIT (SELECT page_size FROM validated)
),
rows AS (
  SELECT COALESCE(
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(paged) ORDER BY paged.failure_date DESC, paged.email_id ASC),
    '[]'::JSONB
  ) AS data
  FROM paged
)
SELECT pg_catalog.jsonb_build_object(
  'data', rows.data,
  'total', summary.total,
  'page', validated.page_number,
  'page_size', validated.page_size,
  'summary', pg_catalog.jsonb_build_object(
    'total', summary.total,
    'bounced', summary.bounced,
    'failed', summary.failed,
    'suppressed', summary.suppressed
  )
)
FROM rows
CROSS JOIN summary
CROSS JOIN validated;
$$;


ALTER FUNCTION "public"."get_delivery_failure_report"("p_status" "text", "p_email_type" "text", "p_search" "text", "p_page" integer, "p_page_size" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_dm_queue_search_page"("p_status" "text" DEFAULT NULL::"text", "p_platform" "text" DEFAULT NULL::"text", "p_city" "text" DEFAULT NULL::"text", "p_search" "text" DEFAULT ''::"text", "p_page" integer DEFAULT 1, "p_page_size" integer DEFAULT 50) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog'
    AS $$
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
$$;


ALTER FUNCTION "public"."get_dm_queue_search_page"("p_status" "text", "p_platform" "text", "p_city" "text", "p_search" "text", "p_page" integer, "p_page_size" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_email_log_search_page"("p_type" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_search" "text" DEFAULT ''::"text", "p_page" integer DEFAULT 1, "p_page_size" integer DEFAULT 50) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog'
    AS $$
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
$$;


ALTER FUNCTION "public"."get_email_log_search_page"("p_type" "text", "p_status" "text", "p_search" "text", "p_page" integer, "p_page_size" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_email_log_summary"("p_type" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_search" "text" DEFAULT ''::"text") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog'
    AS $$
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
$$;


ALTER FUNCTION "public"."get_email_log_summary"("p_type" "text", "p_status" "text", "p_search" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_email_report_leads"("p_addresses" "text"[], "p_domains" "text"[]) RETURNS TABLE("id" "uuid", "business_name" "text", "email" "text", "status" "text")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog'
    AS $$
  WITH matching_leads AS (
    SELECT leads.id, leads.business_name, leads.email, leads.status
    FROM public.leads AS leads
    WHERE leads.email IS NOT NULL
      AND lower(btrim(leads.email)) = ANY (p_addresses)

    UNION

    SELECT leads.id, leads.business_name, leads.email, leads.status
    FROM public.leads AS leads
    WHERE leads.email IS NOT NULL
      AND position('@' IN btrim(leads.email)) > 1
      AND lower(btrim(split_part(btrim(leads.email), '@', 2))) = ANY (p_domains)
  )
  SELECT matching_leads.id,
         matching_leads.business_name,
         matching_leads.email,
         matching_leads.status
  FROM matching_leads
  ORDER BY matching_leads.id;
$$;


ALTER FUNCTION "public"."get_email_report_leads"("p_addresses" "text"[], "p_domains" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_health_summary"("p_as_of" timestamp with time zone DEFAULT "now"()) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog'
    AS $$
WITH latest_finder AS (
  SELECT activity_log.created_at FROM public.activity_log WHERE activity_log.event_type = 'finder_complete' ORDER BY activity_log.created_at DESC LIMIT 1
), latest_cost_guard AS (
  SELECT activity_log.created_at, activity_log.metadata FROM public.activity_log WHERE activity_log.event_type = 'cost_guard_triggered' AND activity_log.created_at >= p_as_of - INTERVAL '2 hours' ORDER BY activity_log.created_at DESC LIMIT 1
), agent_errors AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('description', bounded.description, 'metadata', bounded.metadata, 'created_at', bounded.created_at) ORDER BY bounded.created_at DESC), '[]'::JSONB) AS rows
  FROM (SELECT activity_log.description, activity_log.metadata, activity_log.created_at FROM public.activity_log WHERE activity_log.event_type = 'agent_error' AND activity_log.created_at >= p_as_of - INTERVAL '25 hours' ORDER BY activity_log.created_at DESC LIMIT 5) AS bounded
)
SELECT pg_catalog.jsonb_build_object(
  'system_active', (SELECT settings.value FROM public.settings WHERE settings.key = 'system_active' LIMIT 1),
  'last_pipeline_run', (SELECT latest_finder.created_at FROM latest_finder),
  'outscraper_error', EXISTS (SELECT 1 FROM public.activity_log WHERE created_at >= p_as_of - INTERVAL '24 hours' AND (description ILIKE '%402%' OR description ILIKE '%quota exhausted%' OR description ILIKE '%balance%')),
  'bounce_count', (SELECT COUNT(*) FROM public.emails WHERE status = 'bounced' AND sent_at >= p_as_of - INTERVAL '24 hours'),
  'cost_guard', (SELECT pg_catalog.jsonb_build_object('created_at', latest_cost_guard.created_at, 'metadata', latest_cost_guard.metadata) FROM latest_cost_guard),
  'agent_errors', agent_errors.rows,
  'dead_letter_count', (SELECT COUNT(*) FROM public.dead_letter_queue WHERE resolved = FALSE AND created_at >= p_as_of - INTERVAL '24 hours')
)
FROM agent_errors;
$$;


ALTER FUNCTION "public"."get_health_summary"("p_as_of" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_lead_status_counts"() RETURNS TABLE("status" "text", "count" bigint)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog'
    AS $$
  SELECT leads.status::TEXT, COUNT(*)::BIGINT
  FROM public.leads AS leads
  GROUP BY leads.status
  ORDER BY leads.status;
$$;


ALTER FUNCTION "public"."get_lead_status_counts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_leads_search_page"("p_statuses" "text"[] DEFAULT NULL::"text"[], "p_category" "text" DEFAULT NULL::"text", "p_city" "text" DEFAULT NULL::"text", "p_search" "text" DEFAULT ''::"text", "p_page" integer DEFAULT 1, "p_page_size" integer DEFAULT 50, "p_ids_only" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog'
    AS $$
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
$$;


ALTER FUNCTION "public"."get_leads_search_page"("p_statuses" "text"[], "p_category" "text", "p_city" "text", "p_search" "text", "p_page" integer, "p_page_size" integer, "p_ids_only" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_lifecycle_page"("p_as_of" timestamp with time zone DEFAULT "now"(), "p_filter" "text" DEFAULT 'all'::"text", "p_search" "text" DEFAULT ''::"text", "p_sort_key" "text" DEFAULT 'next_action_date'::"text", "p_sort_dir" "text" DEFAULT 'asc'::"text", "p_page" integer DEFAULT 1, "p_page_size" integer DEFAULT 50) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog'
    AS $$
WITH
validated AS (
  SELECT
    p_as_of AS as_of,
    CASE WHEN p_filter IN ('all', 'fu1_due', 'fu2_due', 'fu3_due', 'fu1', 'fu2', 'fu3', 'fu_due', 'overdue', 'reactivation', 'awaiting_dead', 'dead') THEN p_filter ELSE 'all' END AS filter_key,
    pg_catalog.btrim(COALESCE(p_search, '')) AS search_term,
    CASE WHEN p_sort_key IN ('next_action_date', 'days_since_initial', 'stage') THEN p_sort_key ELSE 'next_action_date' END AS sort_key,
    CASE WHEN pg_catalog.lower(p_sort_dir) = 'desc' THEN 'desc' ELSE 'asc' END AS sort_dir,
    GREATEST(COALESCE(p_page, 1), 1) AS page_number,
    LEAST(GREATEST(COALESCE(p_page_size, 50), 1), 100) AS page_size
),
settings_raw AS (
  SELECT
    MAX(settings.value) FILTER (WHERE settings.key = 'follow_up_1_days') AS fu1,
    MAX(settings.value) FILTER (WHERE settings.key = 'follow_up_2_days') AS fu2,
    MAX(settings.value) FILTER (WHERE settings.key = 'follow_up_3_days') AS fu3,
    MAX(settings.value) FILTER (WHERE settings.key = 'dead_lead_days') AS dead_days,
    MAX(settings.value) FILTER (WHERE settings.key = 'reactivation_delay_days') AS react_days,
    MAX(settings.value) FILTER (WHERE settings.key = 'dead_after_reactivation_days') AS dead_after_react,
    MAX(settings.value) FILTER (WHERE settings.key = 'reactivation_enabled') AS react_enabled
  FROM public.settings AS settings
  WHERE settings.key IN ('follow_up_1_days', 'follow_up_2_days', 'follow_up_3_days', 'dead_lead_days', 'reactivation_delay_days', 'dead_after_reactivation_days', 'reactivation_enabled')
),
settings_values AS (
  SELECT
    COALESCE((SUBSTRING(settings_raw.fu1 FROM '^[+-]?[0-9]+'))::INTEGER, 7) AS fu1,
    COALESCE((SUBSTRING(settings_raw.fu2 FROM '^[+-]?[0-9]+'))::INTEGER, 14) AS fu2,
    COALESCE((SUBSTRING(settings_raw.fu3 FROM '^[+-]?[0-9]+'))::INTEGER, 21) AS fu3,
    COALESCE((SUBSTRING(settings_raw.dead_days FROM '^[+-]?[0-9]+'))::INTEGER, 21) AS dead_days,
    COALESCE((SUBSTRING(settings_raw.react_days FROM '^[+-]?[0-9]+'))::INTEGER, 60) AS react_days,
    COALESCE((SUBSTRING(settings_raw.dead_after_react FROM '^[+-]?[0-9]+'))::INTEGER, 14) AS dead_after_react,
    COALESCE(settings_raw.react_enabled = 'true', FALSE) AS react_enabled
  FROM settings_raw
),
recent_dead AS MATERIALIZED (
  SELECT leads.id
  FROM public.leads AS leads
  WHERE leads.status = 'dead'
  ORDER BY leads.created_at DESC, leads.id ASC
  LIMIT 200
),
candidate_leads AS MATERIALIZED (
  SELECT leads.*
  FROM public.leads AS leads
  WHERE leads.status = 'contacted'
  UNION ALL
  SELECT leads.*
  FROM public.leads AS leads
  JOIN recent_dead ON recent_dead.id = leads.id
),
email_events AS MATERIALIZED (
  SELECT
    leads.id AS lead_id,
    (ARRAY_AGG(emails.sent_at ORDER BY emails.created_at, emails.id) FILTER (WHERE emails.type = 'initial_pitch' AND emails.sent_at IS NOT NULL))[1] AS initial_sent_at,
    COALESCE(BOOL_OR(emails.sent_at IS NOT NULL) FILTER (WHERE emails.type = 'follow_up_1'), FALSE) AS fu1_sent,
    COALESCE(BOOL_OR(emails.sent_at IS NOT NULL) FILTER (WHERE emails.type = 'follow_up_2'), FALSE) AS fu2_sent,
    COALESCE(BOOL_OR(emails.sent_at IS NOT NULL) FILTER (WHERE emails.type = 'follow_up_3'), FALSE) AS fu3_sent
  FROM candidate_leads AS leads
  LEFT JOIN public.emails AS emails ON emails.lead_id = leads.id
  WHERE leads.email IS NOT NULL AND leads.email <> ''
  GROUP BY leads.id
),
facts AS MATERIALIZED (
  SELECT
    leads.id,
    leads.business_name,
    leads.email,
    leads.status,
    leads.reactivation_sent_at,
    email_events.initial_sent_at,
    email_events.fu1_sent,
    email_events.fu2_sent,
    email_events.fu3_sent,
    CASE WHEN email_events.initial_sent_at IS NULL THEN NULL ELSE FLOOR(EXTRACT(EPOCH FROM (validated.as_of - email_events.initial_sent_at)) / 86400)::INTEGER END AS days_since_initial,
    CASE WHEN leads.reactivation_sent_at IS NULL THEN NULL ELSE FLOOR(EXTRACT(EPOCH FROM (validated.as_of - leads.reactivation_sent_at)) / 86400)::INTEGER END AS days_since_reactivation,
    CASE WHEN NOT email_events.fu1_sent THEN 'follow_up_1' WHEN NOT email_events.fu2_sent THEN 'follow_up_2' WHEN NOT email_events.fu3_sent THEN 'follow_up_3' ELSE NULL END AS next_follow_up
  FROM candidate_leads AS leads
  JOIN email_events ON email_events.lead_id = leads.id
  CROSS JOIN validated
),
classified AS MATERIALIZED (
  SELECT
    facts.id,
    facts.business_name,
    facts.email,
    CASE
      WHEN facts.status = 'dead' THEN 'Dead'
      WHEN facts.reactivation_sent_at IS NOT NULL AND facts.days_since_reactivation >= settings_values.dead_after_react THEN 'Awaiting Dead'
      WHEN facts.reactivation_sent_at IS NOT NULL THEN 'Reactivated'
      WHEN facts.initial_sent_at IS NULL THEN 'Unknown'
      WHEN facts.next_follow_up = 'follow_up_3' THEN 'Follow-up 2 Sent'
      WHEN facts.next_follow_up IS NULL AND settings_values.react_enabled AND facts.days_since_initial >= settings_values.react_days THEN 'Reactivation Due'
      WHEN facts.next_follow_up IS NULL THEN 'Follow-up 3 Sent'
      WHEN facts.next_follow_up = 'follow_up_2' THEN 'Follow-up 1 Sent'
      ELSE 'Initial Sent'
    END AS stage,
    CASE
      WHEN facts.status = 'dead' THEN 'None'
      WHEN facts.reactivation_sent_at IS NOT NULL THEN 'Mark Dead'
      WHEN facts.initial_sent_at IS NULL THEN 'None'
      WHEN facts.next_follow_up = 'follow_up_3' THEN 'Send Follow-up 3'
      WHEN facts.next_follow_up IS NULL AND settings_values.react_enabled THEN 'Send Reactivation'
      WHEN facts.next_follow_up IS NULL THEN 'Mark Dead'
      WHEN facts.next_follow_up = 'follow_up_2' THEN 'Send Follow-up 2'
      ELSE 'Send Follow-up 1'
    END AS next_action,
    CASE
      WHEN facts.status = 'dead' THEN NULL
      WHEN facts.reactivation_sent_at IS NOT NULL THEN facts.reactivation_sent_at + pg_catalog.make_interval(days => settings_values.dead_after_react)
      WHEN facts.initial_sent_at IS NULL THEN NULL
      WHEN facts.next_follow_up = 'follow_up_3' THEN facts.initial_sent_at + pg_catalog.make_interval(days => settings_values.fu3)
      WHEN facts.next_follow_up IS NULL AND settings_values.react_enabled THEN facts.initial_sent_at + pg_catalog.make_interval(days => settings_values.react_days)
      WHEN facts.next_follow_up IS NULL THEN facts.initial_sent_at + pg_catalog.make_interval(days => settings_values.dead_days)
      WHEN facts.next_follow_up = 'follow_up_2' THEN facts.initial_sent_at + pg_catalog.make_interval(days => settings_values.fu2)
      ELSE facts.initial_sent_at + pg_catalog.make_interval(days => settings_values.fu1)
    END AS next_action_date,
    facts.days_since_initial,
    CASE
      WHEN facts.status = 'dead' THEN 'dead'
      WHEN facts.reactivation_sent_at IS NOT NULL THEN 'reactivation'
      WHEN facts.initial_sent_at IS NULL THEN 'none'
      WHEN facts.next_follow_up = 'follow_up_3' THEN 'fu3'
      WHEN facts.next_follow_up IS NULL AND settings_values.react_enabled THEN 'reactivation'
      WHEN facts.next_follow_up IS NULL THEN 'none'
      WHEN facts.next_follow_up = 'follow_up_2' THEN 'fu2'
      ELSE 'fu1'
    END AS lifecycle_filter,
    CASE
      WHEN facts.status = 'dead' THEN FALSE
      WHEN facts.reactivation_sent_at IS NOT NULL THEN facts.days_since_reactivation >= settings_values.dead_after_react
      WHEN facts.initial_sent_at IS NULL THEN FALSE
      WHEN facts.next_follow_up = 'follow_up_3' THEN facts.days_since_initial >= settings_values.fu3
      WHEN facts.next_follow_up IS NULL AND settings_values.react_enabled THEN facts.days_since_initial >= settings_values.react_days
      WHEN facts.next_follow_up IS NULL THEN facts.days_since_initial >= settings_values.dead_days
      WHEN facts.next_follow_up = 'follow_up_2' THEN facts.days_since_initial >= settings_values.fu2
      ELSE facts.days_since_initial >= settings_values.fu1
    END AS is_overdue
  FROM facts
  CROSS JOIN settings_values
),
counts AS (
  SELECT
    COUNT(*)::BIGINT AS all_count,
    COUNT(*) FILTER (WHERE lifecycle_filter IN ('fu1', 'fu2', 'fu3') AND is_overdue)::BIGINT AS fu_due,
    COUNT(*) FILTER (WHERE lifecycle_filter = 'fu1' AND is_overdue)::BIGINT AS fu1_due,
    COUNT(*) FILTER (WHERE lifecycle_filter = 'fu2' AND is_overdue)::BIGINT AS fu2_due,
    COUNT(*) FILTER (WHERE lifecycle_filter = 'fu3' AND is_overdue)::BIGINT AS fu3_due,
    COUNT(*) FILTER (WHERE lifecycle_filter = 'fu1')::BIGINT AS fu1,
    COUNT(*) FILTER (WHERE lifecycle_filter = 'fu2')::BIGINT AS fu2,
    COUNT(*) FILTER (WHERE lifecycle_filter = 'fu3')::BIGINT AS fu3,
    COUNT(*) FILTER (WHERE is_overdue)::BIGINT AS overdue,
    COUNT(*) FILTER (WHERE lifecycle_filter = 'reactivation' AND stage <> 'Awaiting Dead')::BIGINT AS reactivation,
    COUNT(*) FILTER (WHERE stage = 'Awaiting Dead')::BIGINT AS awaiting_dead,
    COUNT(*) FILTER (WHERE lifecycle_filter = 'dead')::BIGINT AS dead
  FROM classified
),
matched AS MATERIALIZED (
  SELECT classified.*
  FROM classified
  CROSS JOIN validated
  WHERE
    (validated.search_term = ''
      OR classified.business_name ILIKE '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(validated.search_term, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%' ESCAPE E'\\'
      OR classified.email ILIKE '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(validated.search_term, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%' ESCAPE E'\\')
    AND CASE validated.filter_key
      WHEN 'fu_due' THEN classified.lifecycle_filter IN ('fu1', 'fu2', 'fu3') AND classified.is_overdue
      WHEN 'fu1_due' THEN classified.lifecycle_filter = 'fu1' AND classified.is_overdue
      WHEN 'fu2_due' THEN classified.lifecycle_filter = 'fu2' AND classified.is_overdue
      WHEN 'fu3_due' THEN classified.lifecycle_filter = 'fu3' AND classified.is_overdue
      WHEN 'overdue' THEN classified.is_overdue
      WHEN 'fu1' THEN classified.lifecycle_filter = 'fu1'
      WHEN 'fu2' THEN classified.lifecycle_filter = 'fu2'
      WHEN 'fu3' THEN classified.lifecycle_filter = 'fu3'
      WHEN 'reactivation' THEN classified.lifecycle_filter = 'reactivation' AND classified.stage <> 'Awaiting Dead'
      WHEN 'awaiting_dead' THEN classified.stage = 'Awaiting Dead'
      WHEN 'dead' THEN classified.lifecycle_filter = 'dead'
      ELSE TRUE
    END
),
paged AS (
  SELECT matched.*
  FROM matched
  CROSS JOIN validated
  ORDER BY
    CASE WHEN validated.sort_key = 'next_action_date' AND validated.sort_dir = 'asc' THEN matched.next_action_date END ASC NULLS LAST,
    CASE WHEN validated.sort_key = 'next_action_date' AND validated.sort_dir = 'desc' THEN matched.next_action_date END DESC NULLS FIRST,
    CASE WHEN validated.sort_key = 'days_since_initial' AND validated.sort_dir = 'asc' THEN COALESCE(matched.days_since_initial, -1) END ASC,
    CASE WHEN validated.sort_key = 'days_since_initial' AND validated.sort_dir = 'desc' THEN COALESCE(matched.days_since_initial, -1) END DESC,
    CASE WHEN validated.sort_key = 'stage' AND validated.sort_dir = 'asc' THEN matched.stage END ASC,
    CASE WHEN validated.sort_key = 'stage' AND validated.sort_dir = 'desc' THEN matched.stage END DESC,
    matched.id ASC
  OFFSET ((SELECT page_number - 1 FROM validated) * (SELECT page_size FROM validated))
  LIMIT (SELECT page_size FROM validated)
),
records AS (
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', paged.id,
    'business_name', paged.business_name,
    'email', paged.email,
    'stage', paged.stage,
    'days_since_initial', paged.days_since_initial,
    'next_action', paged.next_action,
    'next_action_date', paged.next_action_date,
    'filter_key', paged.lifecycle_filter,
    'is_overdue', paged.is_overdue
  ) ORDER BY
    CASE WHEN validated.sort_key = 'next_action_date' AND validated.sort_dir = 'asc' THEN paged.next_action_date END ASC NULLS LAST,
    CASE WHEN validated.sort_key = 'next_action_date' AND validated.sort_dir = 'desc' THEN paged.next_action_date END DESC NULLS FIRST,
    CASE WHEN validated.sort_key = 'days_since_initial' AND validated.sort_dir = 'asc' THEN COALESCE(paged.days_since_initial, -1) END ASC,
    CASE WHEN validated.sort_key = 'days_since_initial' AND validated.sort_dir = 'desc' THEN COALESCE(paged.days_since_initial, -1) END DESC,
    CASE WHEN validated.sort_key = 'stage' AND validated.sort_dir = 'asc' THEN paged.stage END ASC,
    CASE WHEN validated.sort_key = 'stage' AND validated.sort_dir = 'desc' THEN paged.stage END DESC,
    paged.id ASC
  ), '[]'::JSONB) AS rows
  FROM paged
  CROSS JOIN validated
),
dead_today AS (
  SELECT COUNT(*)::BIGINT AS count
  FROM public.activity_log
  CROSS JOIN validated
  WHERE event_type = 'lead_marked_dead'
    AND created_at >= ((validated.as_of AT TIME ZONE 'Australia/Sydney')::DATE::TIMESTAMP AT TIME ZONE 'Australia/Sydney')
    AND created_at < ((((validated.as_of AT TIME ZONE 'Australia/Sydney')::DATE + 1)::TIMESTAMP) AT TIME ZONE 'Australia/Sydney')
)
SELECT pg_catalog.jsonb_build_object(
  'data', records.rows,
  'total', (SELECT COUNT(*) FROM matched),
  'page', validated.page_number,
  'page_size', validated.page_size,
  'counts', pg_catalog.jsonb_build_object('all', counts.all_count, 'fu_due', counts.fu_due, 'fu1_due', counts.fu1_due, 'fu2_due', counts.fu2_due, 'fu3_due', counts.fu3_due, 'fu1', counts.fu1, 'fu2', counts.fu2, 'fu3', counts.fu3, 'overdue', counts.overdue, 'reactivation', counts.reactivation, 'awaiting_dead', counts.awaiting_dead, 'dead', counts.dead),
  'summary', pg_catalog.jsonb_build_object('fu1_due', counts.fu1_due, 'fu2_due', counts.fu2_due, 'fu3_due', counts.fu3_due, 'reactivation_due', (SELECT COUNT(*) FROM classified WHERE stage = 'Reactivation Due'), 'awaiting_dead', counts.awaiting_dead, 'dead_today', dead_today.count)
)
FROM validated CROSS JOIN counts CROSS JOIN records CROSS JOIN dead_today;
$$;


ALTER FUNCTION "public"."get_lifecycle_page"("p_as_of" timestamp with time zone, "p_filter" "text", "p_search" "text", "p_sort_key" "text", "p_sort_dir" "text", "p_page" integer, "p_page_size" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_pipeline_search_page"("p_statuses" "text"[], "p_search" "text" DEFAULT ''::"text", "p_page" integer DEFAULT 1, "p_page_size" integer DEFAULT 50) RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog'
    AS $$
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
$$;


ALTER FUNCTION "public"."get_pipeline_search_page"("p_statuses" "text"[], "p_search" "text", "p_page" integer, "p_page_size" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_auth_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  admin_email TEXT := current_setting('app.admin_email', true);
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, is_active)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    NEW.raw_user_meta_data ->> 'full_name',
    CASE
      WHEN admin_email IS NOT NULL AND lower(NEW.email) = lower(admin_email) THEN 'admin'
      ELSE COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'role', ''), 'member')
    END,
    true
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(EXCLUDED.full_name, profiles.full_name);

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_auth_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_active_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
      AND is_active = true
  );
$$;


ALTER FUNCTION "public"."is_active_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."literal_ilike_pattern"("p_search" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE PARALLEL SAFE
    SET "search_path" TO 'pg_catalog'
    AS $$
  SELECT '%' || pg_catalog.replace(
    pg_catalog.replace(
      pg_catalog.replace(pg_catalog.btrim(COALESCE(p_search, '')), E'\\', E'\\\\'),
      '%', E'\\%'
    ),
    '_', E'\\_'
  ) || '%';
$$;


ALTER FUNCTION "public"."literal_ilike_pattern"("p_search" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_lead_fields"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.business_name := NULLIF(BTRIM(NEW.business_name), '');
  NEW.email := NULLIF(BTRIM(NEW.email), '');
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."normalize_lead_fields"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_email_group_quality"("p_email" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."refresh_email_group_quality"("p_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_lead_data_quality"("p_lead_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."refresh_lead_data_quality"("p_lead_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_recipient_outreach_claim"("p_lead_id" "uuid", "p_normalized_email" "text", "p_claim_token" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_email TEXT := NULLIF(lower(btrim(p_normalized_email)), '');
BEGIN
  IF v_email IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_email, 734921));

  UPDATE recipient_outreach_ownership o
  SET owner_lead_id = NULL,
      state = 'released',
      last_activity_at = now(),
      metadata = o.metadata || jsonb_build_object(
        'released_source', 'generation_persistence_failure',
        'released_lead_id', p_lead_id,
        'released_at', now()
      )
  WHERE o.normalized_email = v_email
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
        AND l.status IN ('email_ready','contacted','replied','negotiating','interested','closed_won','closed','closed_manual')
    );
  RETURN FOUND;
END;
$$;


ALTER FUNCTION "public"."release_recipient_outreach_claim"("p_lead_id" "uuid", "p_normalized_email" "text", "p_claim_token" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_data_quality_emails"("p_lead_ids" "uuid"[], "p_actor_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."remove_data_quality_emails"("p_lead_ids" "uuid"[], "p_actor_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_data_quality_flag_status"("p_issue_type" "text", "p_normalized_email" "text" DEFAULT NULL::"text", "p_lead_ids" "uuid"[] DEFAULT NULL::"uuid"[], "p_status" "text" DEFAULT 'resolved'::"text", "p_resolution_reason" "text" DEFAULT NULL::"text", "p_actor_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."set_data_quality_flag_status"("p_issue_type" "text", "p_normalized_email" "text", "p_lead_ids" "uuid"[], "p_status" "text", "p_resolution_reason" "text", "p_actor_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_lead_normalized_email"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.normalized_email := NULLIF(lower(btrim(NEW.email)), '');
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_lead_normalized_email"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."suppress_lead_delivery_email"("p_lead_id" "uuid", "p_email" "text") RETURNS "void"
    LANGUAGE "sql"
    SET "search_path" TO ''
    AS $$
  UPDATE public.leads
  SET delivery_suppressed_emails = CASE
    WHEN pg_catalog.lower(pg_catalog.btrim(p_email)) = ANY(delivery_suppressed_emails)
      THEN delivery_suppressed_emails
    ELSE pg_catalog.array_append(delivery_suppressed_emails, pg_catalog.lower(pg_catalog.btrim(p_email)))
  END
  WHERE id = p_lead_id
    AND pg_catalog.btrim(p_email) <> '';
$$;


ALTER FUNCTION "public"."suppress_lead_delivery_email"("p_lead_id" "uuid", "p_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_refresh_lead_data_quality"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.normalized_email IS DISTINCT FROM NEW.normalized_email THEN
    PERFORM refresh_email_group_quality(OLD.normalized_email);
  END IF;
  PERFORM refresh_lead_data_quality(NEW.id);
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_refresh_lead_data_quality"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_customer_on_message"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    UPDATE customers
    SET
        last_seen_at  = NOW(),
        message_count = message_count + 1,
        name          = COALESCE(name, NULL)   -- name updated separately by app layer
    WHERE id = NEW.customer_id;
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_customer_on_message"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."activity_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_type" "text" NOT NULL,
    "lead_id" "uuid",
    "description" "text" NOT NULL,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."activity_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_models" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "model_key" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_models" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_providers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_key" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_providers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_request_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "started_at" timestamp with time zone NOT NULL,
    "finished_at" timestamp with time zone NOT NULL,
    "workflow" "text" NOT NULL,
    "provider" "text",
    "model" "text",
    "status" "text" NOT NULL,
    "duration_ms" integer NOT NULL,
    "input_tokens" integer,
    "output_tokens" integer,
    "total_tokens" integer,
    "estimated_cost_usd" numeric(16,10),
    "error_message" "text",
    "retry_count" integer DEFAULT 0 NOT NULL,
    "request_source" "text" DEFAULT 'application'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "ai_request_logs_duration_ms_check" CHECK (("duration_ms" >= 0)),
    CONSTRAINT "ai_request_logs_estimated_cost_usd_check" CHECK (("estimated_cost_usd" >= (0)::numeric)),
    CONSTRAINT "ai_request_logs_input_tokens_check" CHECK (("input_tokens" >= 0)),
    CONSTRAINT "ai_request_logs_metadata_object" CHECK (("jsonb_typeof"("metadata") = 'object'::"text")),
    CONSTRAINT "ai_request_logs_output_tokens_check" CHECK (("output_tokens" >= 0)),
    CONSTRAINT "ai_request_logs_retry_count_check" CHECK (("retry_count" >= 0)),
    CONSTRAINT "ai_request_logs_status_check" CHECK (("status" = ANY (ARRAY['succeeded'::"text", 'failed'::"text"]))),
    CONSTRAINT "ai_request_logs_time_order" CHECK (("finished_at" >= "started_at")),
    CONSTRAINT "ai_request_logs_total_tokens_check" CHECK (("total_tokens" >= 0))
);


ALTER TABLE "public"."ai_request_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_workflow_configurations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workflow_key" "text" NOT NULL,
    "model_id" "uuid" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_workflow_configurations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bookings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "conversation_id" "uuid",
    "customer_name" "text" NOT NULL,
    "customer_phone" "text" NOT NULL,
    "booking_date" "date" NOT NULL,
    "booking_time" time without time zone NOT NULL,
    "guests" integer DEFAULT 1 NOT NULL,
    "notes" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "confirmed_by" "text",
    "confirmed_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "cancellation_reason" "text",
    "reminder_sent" boolean DEFAULT false NOT NULL,
    "reminder_sent_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bookings_guests_check" CHECK (("guests" > 0)),
    CONSTRAINT "bookings_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'confirmed'::"text", 'cancelled'::"text", 'no_show'::"text", 'completed'::"text"])))
);


ALTER TABLE "public"."bookings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "halal_filter" boolean DEFAULT false,
    "cities" "text" DEFAULT 'all'::"text",
    "custom_cities" "text"[],
    "content_type" "text" DEFAULT 'remote'::"text",
    "pitch_template" "text",
    "dm_template" "text",
    "search_keywords" "text"[],
    "status" "text" DEFAULT 'active'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "use_priority_suburbs" boolean DEFAULT false NOT NULL,
    "city_content_types" "jsonb",
    CONSTRAINT "categories_cities_check" CHECK (("cities" = ANY (ARRAY['sydney_only'::"text", 'all'::"text", 'custom'::"text"]))),
    CONSTRAINT "categories_content_type_check" CHECK (("content_type" = ANY (ARRAY['visit'::"text", 'remote'::"text", 'both'::"text"]))),
    CONSTRAINT "categories_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'paused'::"text"])))
);


ALTER TABLE "public"."categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."category_email_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "category_id" "uuid" NOT NULL,
    "template_type" "text" NOT NULL,
    "subject_template" "text",
    "body_template" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "category_email_templates_template_type_check" CHECK (("template_type" = ANY (ARRAY['initial_pitch'::"text", 'follow_up_1'::"text", 'follow_up_2'::"text", 'follow_up_3'::"text", 'reactivation'::"text"])))
);


ALTER TABLE "public"."category_email_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."category_suburb_priorities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "category_id" "uuid" NOT NULL,
    "city_suburb_id" "uuid" NOT NULL,
    "priority" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "category_suburb_priorities_priority_check" CHECK ((("priority" >= 1) AND ("priority" <= 10)))
);


ALTER TABLE "public"."category_suburb_priorities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."category_suburb_search_state" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "category_id" "uuid" NOT NULL,
    "city_suburb_id" "uuid" NOT NULL,
    "last_searched_at" timestamp with time zone,
    "exhausted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."category_suburb_search_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."city_suburbs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "city" "text" NOT NULL,
    "suburb" "text" NOT NULL,
    "active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "last_used_at" timestamp with time zone,
    "priority" integer DEFAULT 1
);


ALTER TABLE "public"."city_suburbs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_name" "text" NOT NULL,
    "business_type" "text" NOT NULL,
    "abn" "text",
    "owner_name" "text" NOT NULL,
    "owner_email" "text" NOT NULL,
    "owner_whatsapp" "text" NOT NULL,
    "address_street" "text",
    "address_suburb" "text",
    "address_state" "text",
    "address_postcode" "text",
    "address_full" "text" GENERATED ALWAYS AS (((((((COALESCE("address_street", ''::"text") || ', '::"text") || COALESCE("address_suburb", ''::"text")) || ' '::"text") || COALESCE("address_state", ''::"text")) || ' '::"text") || COALESCE("address_postcode", ''::"text"))) STORED,
    "business_phone" "text",
    "business_whatsapp" "text",
    "whatsapp_phone_number_id" "text",
    "website_url" "text",
    "plan" "text" DEFAULT 'trial'::"text" NOT NULL,
    "plan_started_at" timestamp with time zone,
    "trial_started_at" timestamp with time zone DEFAULT "now"(),
    "trial_ends_at" timestamp with time zone DEFAULT ("now"() + '14 days'::interval),
    "stripe_customer_id" "text",
    "stripe_subscription_id" "text",
    "ai_active" boolean DEFAULT true NOT NULL,
    "escalation_whatsapp" "text",
    "ai_language" "text" DEFAULT 'en'::"text" NOT NULL,
    "max_tokens" integer DEFAULT 500 NOT NULL,
    "temperature" numeric(3,2) DEFAULT 0.3 NOT NULL,
    "n8n_workflow_id" "text",
    "google_sheet_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "clients_business_type_check" CHECK (("business_type" = ANY (ARRAY['restaurant'::"text", 'cafe'::"text", 'salon'::"text", 'tradie'::"text", 'other'::"text"]))),
    CONSTRAINT "clients_plan_check" CHECK (("plan" = ANY (ARRAY['trial'::"text", 'starter'::"text", 'growth'::"text", 'pro'::"text", 'paused'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."clients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "whatsapp_message_id" "text",
    "role" "text" NOT NULL,
    "message_text" "text" NOT NULL,
    "intent" "text",
    "escalated" boolean DEFAULT false NOT NULL,
    "model_used" "text",
    "tokens_used" integer,
    "latency_ms" integer,
    "error" "text",
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "conversations_intent_check" CHECK (("intent" = ANY (ARRAY['faq'::"text", 'booking'::"text", 'complaint'::"text", 'escalation'::"text", 'opt_out'::"text", 'other'::"text"]))),
    CONSTRAINT "conversations_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text", 'system'::"text"])))
);


ALTER TABLE "public"."conversations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "phone" "text" NOT NULL,
    "name" "text",
    "opted_out" boolean DEFAULT false NOT NULL,
    "opted_out_at" timestamp with time zone,
    "data_deletion_requested" boolean DEFAULT false NOT NULL,
    "data_deletion_at" timestamp with time zone,
    "first_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "message_count" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."customers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dead_letter_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "operation" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error" "text",
    "resolved" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "resolved_at" timestamp with time zone
);


ALTER TABLE "public"."dead_letter_queue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lead_id" "uuid",
    "deal_value" numeric(10,2) NOT NULL,
    "deal_type" "text" NOT NULL,
    "content_created" boolean DEFAULT false,
    "content_created_at" timestamp with time zone,
    "payment_received" boolean DEFAULT false,
    "payment_received_at" timestamp with time zone,
    "notes" "text",
    "closed_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "deals_deal_type_check" CHECK (("deal_type" = ANY (ARRAY['visit_content'::"text", 'remote_sponsored'::"text", 'remote_content'::"text"])))
);


ALTER TABLE "public"."deals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."discovery_run_metrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "text" NOT NULL,
    "run_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "email_target" integer DEFAULT 0 NOT NULL,
    "dm_target" integer DEFAULT 0 NOT NULL,
    "total_target" integer DEFAULT 0 NOT NULL,
    "outscraper_calls" integer DEFAULT 0 NOT NULL,
    "total_results_fetched" integer DEFAULT 0 NOT NULL,
    "outscraper_results_fetched" integer DEFAULT 0 NOT NULL,
    "businesses_processed" integer DEFAULT 0 NOT NULL,
    "queries_executed" integer DEFAULT 0 NOT NULL,
    "irrelevant_skips" integer DEFAULT 0 NOT NULL,
    "keyword_filtered_skips" integer DEFAULT 0 NOT NULL,
    "early_duplicate_skips" integer DEFAULT 0 NOT NULL,
    "db_duplicate_skips" integer DEFAULT 0 NOT NULL,
    "dedupe_index_skips" integer DEFAULT 0 NOT NULL,
    "no_website_skips" integer DEFAULT 0 NOT NULL,
    "social_only_skips" integer DEFAULT 0 NOT NULL,
    "website_no_email_skips" integer DEFAULT 0 NOT NULL,
    "invalid_emails_removed" integer DEFAULT 0 NOT NULL,
    "halal_confidence_recorded" integer DEFAULT 0 NOT NULL,
    "qualified_candidates" integer DEFAULT 0 NOT NULL,
    "email_leads_saved" integer DEFAULT 0 NOT NULL,
    "dm_leads_queued" integer DEFAULT 0 NOT NULL,
    "total_leads_saved" integer DEFAULT 0 NOT NULL,
    "duplicate_rate_pct" numeric(5,2),
    "qualification_rate_pct" numeric(5,2),
    "website_coverage_pct" numeric(5,2),
    "email_extraction_rate_pct" numeric(5,2),
    "efficiency_pct" numeric(5,2),
    "estimated_cost_usd" numeric(10,4),
    "exit_reason" "text",
    "runtime_ms" integer,
    "safety_limit_hit" boolean DEFAULT false NOT NULL,
    "safety_limit_reason" "text",
    "cost_guard_hit" boolean DEFAULT false NOT NULL,
    "top_yield_queries" "jsonb",
    "worst_duplicate_queries" "jsonb",
    "worst_suburb_overlap_queries" "jsonb",
    "lowest_qualification_queries" "jsonb"
);


ALTER TABLE "public"."discovery_run_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."distributed_locks" (
    "lock_key" "text" NOT NULL,
    "locked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "owner_token" "text"
);


ALTER TABLE "public"."distributed_locks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dm_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lead_id" "uuid",
    "platform" "text" NOT NULL,
    "handle" "text" NOT NULL,
    "profile_url" "text",
    "message_text" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "sent_at" timestamp with time zone,
    CONSTRAINT "dm_queue_platform_check" CHECK (("platform" = ANY (ARRAY['instagram'::"text", 'facebook'::"text"]))),
    CONSTRAINT "dm_queue_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."dm_queue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."emails" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lead_id" "uuid",
    "type" "text" NOT NULL,
    "subject" "text" NOT NULL,
    "body_html" "text" NOT NULL,
    "body_text" "text" NOT NULL,
    "resend_id" "text",
    "status" "text" DEFAULT 'pending_send'::"text",
    "sent_at" timestamp with time zone,
    "opened_at" timestamp with time zone,
    "replied_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "edited_at" timestamp with time zone,
    "edited_by_user" boolean DEFAULT false,
    "message_id" "text",
    "generation_source" "text",
    CONSTRAINT "emails_generation_source_check" CHECK ((("generation_source" IS NULL) OR ("generation_source" = ANY (ARRAY['ai'::"text", 'template'::"text"])))),
    CONSTRAINT "emails_status_check" CHECK (("status" = ANY (ARRAY['pending_send'::"text", 'sent'::"text", 'failed'::"text", 'bounced'::"text", 'suppressed'::"text", 'email_sync_failed'::"text"]))),
    CONSTRAINT "emails_type_check" CHECK (("type" = ANY (ARRAY['initial_pitch'::"text", 'follow_up_1'::"text", 'follow_up_2'::"text", 'follow_up_3'::"text", 'reactivation'::"text"])))
);


ALTER TABLE "public"."emails" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."escalations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "conversation_id" "uuid",
    "reason" "text",
    "trigger_message" "text" NOT NULL,
    "owner_alerted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "owner_responded_at" timestamp with time zone,
    "owner_response_ms" integer GENERATED ALWAYS AS (
CASE
    WHEN ("owner_responded_at" IS NOT NULL) THEN ((EXTRACT(epoch FROM ("owner_responded_at" - "owner_alerted_at")))::integer * 1000)
    ELSE NULL::integer
END) STORED,
    "reminder_sent" boolean DEFAULT false NOT NULL,
    "reminder_sent_at" timestamp with time zone,
    "resolved" boolean DEFAULT false NOT NULL,
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."escalations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."exhausted_queries" (
    "query" "text" NOT NULL,
    "city" "text" NOT NULL,
    "category" "text" NOT NULL,
    "exhausted_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone DEFAULT ("now"() + '3 days'::interval)
);


ALTER TABLE "public"."exhausted_queries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."follow_ups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lead_id" "uuid",
    "follow_up_number" integer NOT NULL,
    "scheduled_at" timestamp with time zone NOT NULL,
    "sent_at" timestamp with time zone,
    "email_id" "uuid",
    "status" "text" DEFAULT 'scheduled'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "follow_ups_follow_up_number_check" CHECK (("follow_up_number" = ANY (ARRAY[1, 2, 3]))),
    CONSTRAINT "follow_ups_status_check" CHECK (("status" = ANY (ARRAY['scheduled'::"text", 'sent'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."follow_ups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inbound_receipts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider" "text" NOT NULL,
    "receipt_key" "text" NOT NULL,
    "mailbox_id" "text",
    "folder" "text",
    "uid" "text",
    "provider_message_id" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "outcome" "text",
    "trigger_run_id" "text",
    "processing_run_id" "text",
    "processing_started_at" timestamp with time zone,
    "processed_at" timestamp with time zone,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "inbound_receipts_provider_check" CHECK (("provider" = ANY (ARRAY['hostinger'::"text", 'resend'::"text"]))),
    CONSTRAINT "inbound_receipts_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'queued'::"text", 'processing'::"text", 'processed'::"text", 'ignored'::"text", 'unmatched'::"text", 'unmatched_ambiguous'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."inbound_receipts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."knowledge_base" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "category" "text" NOT NULL,
    "question" "text" NOT NULL,
    "answer" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "knowledge_base_category_check" CHECK (("category" = ANY (ARRAY['hours'::"text", 'location'::"text", 'menu'::"text", 'booking'::"text", 'pricing'::"text", 'parking'::"text", 'policy'::"text", 'faq'::"text", 'services'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."knowledge_base" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lead_data_quality_flags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lead_id" "uuid" NOT NULL,
    "normalized_email" "text",
    "issue_type" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "related_lead_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "resolution_reason" "text",
    "resolved_by" "uuid",
    CONSTRAINT "lead_data_quality_flags_issue_type_check" CHECK (("issue_type" = ANY (ARRAY['duplicate_lead'::"text", 'shared_email'::"text", 'uncertain_email_group'::"text", 'invalid_email'::"text", 'placeholder_email'::"text", 'technical_email'::"text", 'already_contacted_email'::"text"]))),
    CONSTRAINT "lead_data_quality_flags_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'resolved'::"text"])))
);


ALTER TABLE "public"."lead_data_quality_flags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_name" "text" NOT NULL,
    "category_id" "uuid",
    "category_name" "text" NOT NULL,
    "halal" boolean DEFAULT false,
    "address" "text",
    "suburb" "text",
    "city" "text" NOT NULL,
    "state" "text",
    "phone" "text",
    "email" "text",
    "website" "text",
    "instagram_handle" "text",
    "facebook_url" "text",
    "google_rating" numeric(2,1),
    "google_reviews_count" integer,
    "description" "text",
    "services" "text",
    "outreach_channel" "text" DEFAULT 'email'::"text",
    "status" "text" DEFAULT 'new'::"text",
    "deal_value" numeric(10,2),
    "deal_type" "text",
    "content_created" boolean DEFAULT false,
    "payment_received" boolean DEFAULT false,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "halal_confidence_score" integer,
    "halal_reasons" "jsonb",
    "reactivation_sent_at" timestamp with time zone,
    "source" "text",
    "content_type" "text",
    "delivery_suppressed_emails" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "normalized_email" "text",
    "outreach_suppression_reason" "text",
    "outreach_suppressed_at" timestamp with time zone,
    CONSTRAINT "leads_content_type_check" CHECK (("content_type" = ANY (ARRAY['visit'::"text", 'remote'::"text"]))),
    CONSTRAINT "leads_deal_type_check" CHECK (("deal_type" = ANY (ARRAY['visit_content'::"text", 'remote_sponsored'::"text", 'remote_content'::"text"]))),
    CONSTRAINT "leads_outreach_channel_check" CHECK (("outreach_channel" = ANY (ARRAY['email'::"text", 'instagram'::"text", 'facebook'::"text"]))),
    CONSTRAINT "leads_source_check" CHECK (("source" = ANY (ARRAY['finder'::"text", 'manual'::"text"]))),
    CONSTRAINT "leads_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'researched'::"text", 'email_ready'::"text", 'contacted'::"text", 'replied'::"text", 'negotiating'::"text", 'closed'::"text", 'closed_manual'::"text", 'dead'::"text"])))
);


ALTER TABLE "public"."leads" OWNER TO "postgres";


COMMENT ON COLUMN "public"."leads"."source" IS 'How a lead entered the system: NULL = finder pipeline (legacy), ''manual'' = manually added via UI';



COMMENT ON COLUMN "public"."leads"."delivery_suppressed_emails" IS 'Normalised recipient addresses with a terminal Resend delivery event. A different lead email remains eligible.';



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "role" "text" DEFAULT 'member'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'member'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."recipient_outreach_ownership" (
    "normalized_email" "text" NOT NULL,
    "owner_lead_id" "uuid",
    "state" "text" DEFAULT 'active'::"text" NOT NULL,
    "claimed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_activity_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "recipient_outreach_ownership_state_check" CHECK (("state" = ANY (ARRAY['active'::"text", 'released'::"text"])))
);


ALTER TABLE "public"."recipient_outreach_ownership" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."search_cache" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "query" "text" NOT NULL,
    "results" "jsonb" NOT NULL,
    "api_used" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval)
);


ALTER TABLE "public"."search_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "key" "text" NOT NULL,
    "value" "text" NOT NULL,
    "description" "text",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "settings_initial_email_mode_value_check" CHECK ((("key" <> 'initial_email_mode'::"text") OR ("value" = ANY (ARRAY['ai_personalised'::"text", 'template'::"text"]))))
);


ALTER TABLE "public"."settings" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_bookings_full" AS
 SELECT "b"."id",
    "b"."client_id",
    "b"."customer_id",
    "b"."conversation_id",
    "b"."customer_name",
    "b"."customer_phone",
    "b"."booking_date",
    "b"."booking_time",
    "b"."guests",
    "b"."notes",
    "b"."status",
    "b"."confirmed_by",
    "b"."confirmed_at",
    "b"."cancelled_at",
    "b"."cancellation_reason",
    "b"."reminder_sent",
    "b"."reminder_sent_at",
    "b"."created_at",
    "b"."updated_at",
    "cu"."name" AS "customer_name_resolved",
    "cu"."phone" AS "customer_phone_resolved"
   FROM ("public"."bookings" "b"
     JOIN "public"."customers" "cu" ON (("cu"."id" = "b"."customer_id")));


ALTER VIEW "public"."v_bookings_full" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_conversation_thread" AS
 SELECT "conv"."id",
    "conv"."client_id",
    "conv"."customer_id",
    "cu"."phone",
    "cu"."name" AS "customer_name",
    "conv"."role",
    "conv"."message_text",
    "conv"."intent",
    "conv"."escalated",
    "conv"."sent_at"
   FROM ("public"."conversations" "conv"
     JOIN "public"."customers" "cu" ON (("cu"."id" = "conv"."customer_id")))
  ORDER BY "conv"."sent_at";


ALTER VIEW "public"."v_conversation_thread" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_daily_summary" AS
 SELECT "c"."id" AS "client_id",
    "c"."business_name",
    "count"(DISTINCT "conv"."id") FILTER (WHERE (("conv"."role" = 'user'::"text") AND ("conv"."sent_at" >= CURRENT_DATE))) AS "messages_today",
    "count"(DISTINCT "b"."id") FILTER (WHERE (("b"."created_at" >= CURRENT_DATE) AND ("b"."status" <> 'cancelled'::"text"))) AS "bookings_today",
    "count"(DISTINCT "e"."id") FILTER (WHERE (("e"."created_at" >= CURRENT_DATE) AND ("e"."resolved" = false))) AS "open_escalations",
    "c"."ai_active"
   FROM ((("public"."clients" "c"
     LEFT JOIN "public"."conversations" "conv" ON (("conv"."client_id" = "c"."id")))
     LEFT JOIN "public"."bookings" "b" ON (("b"."client_id" = "c"."id")))
     LEFT JOIN "public"."escalations" "e" ON (("e"."client_id" = "c"."id")))
  GROUP BY "c"."id", "c"."business_name", "c"."ai_active";


ALTER VIEW "public"."v_daily_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."weekly_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_id" "uuid" NOT NULL,
    "week_start" "date" NOT NULL,
    "week_end" "date" NOT NULL,
    "total_messages" integer DEFAULT 0 NOT NULL,
    "user_messages" integer DEFAULT 0 NOT NULL,
    "ai_responses" integer DEFAULT 0 NOT NULL,
    "unique_customers" integer DEFAULT 0 NOT NULL,
    "faq_count" integer DEFAULT 0 NOT NULL,
    "booking_count" integer DEFAULT 0 NOT NULL,
    "complaint_count" integer DEFAULT 0 NOT NULL,
    "escalation_count" integer DEFAULT 0 NOT NULL,
    "other_count" integer DEFAULT 0 NOT NULL,
    "bookings_captured" integer DEFAULT 0 NOT NULL,
    "bookings_confirmed" integer DEFAULT 0 NOT NULL,
    "bookings_cancelled" integer DEFAULT 0 NOT NULL,
    "bookings_no_show" integer DEFAULT 0 NOT NULL,
    "total_guests" integer DEFAULT 0 NOT NULL,
    "avg_response_ms" integer,
    "busiest_day" "text",
    "busiest_hour" integer,
    "top_questions" "jsonb",
    "top_intents" "jsonb",
    "estimated_hours_saved" numeric(6,2),
    "report_sent" boolean DEFAULT false NOT NULL,
    "report_sent_at" timestamp with time zone,
    "report_text" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."weekly_reports" OWNER TO "postgres";


ALTER TABLE ONLY "public"."activity_log"
    ADD CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_models"
    ADD CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_models"
    ADD CONSTRAINT "ai_models_provider_model_unique" UNIQUE ("provider_id", "model_key");



ALTER TABLE ONLY "public"."ai_providers"
    ADD CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_providers"
    ADD CONSTRAINT "ai_providers_provider_key_key" UNIQUE ("provider_key");



ALTER TABLE ONLY "public"."ai_request_logs"
    ADD CONSTRAINT "ai_request_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_workflow_configurations"
    ADD CONSTRAINT "ai_workflow_configurations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_workflow_configurations"
    ADD CONSTRAINT "ai_workflow_configurations_workflow_key_key" UNIQUE ("workflow_key");



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."category_email_templates"
    ADD CONSTRAINT "category_email_templates_category_type_unique" UNIQUE ("category_id", "template_type");



ALTER TABLE ONLY "public"."category_email_templates"
    ADD CONSTRAINT "category_email_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."category_suburb_priorities"
    ADD CONSTRAINT "category_suburb_priorities_category_suburb_unique" UNIQUE ("category_id", "city_suburb_id");



ALTER TABLE ONLY "public"."category_suburb_priorities"
    ADD CONSTRAINT "category_suburb_priorities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."category_suburb_search_state"
    ADD CONSTRAINT "category_suburb_search_state_category_suburb_unique" UNIQUE ("category_id", "city_suburb_id");



ALTER TABLE ONLY "public"."category_suburb_search_state"
    ADD CONSTRAINT "category_suburb_search_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."city_suburbs"
    ADD CONSTRAINT "city_suburbs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_owner_email_key" UNIQUE ("owner_email");



ALTER TABLE ONLY "public"."clients"
    ADD CONSTRAINT "clients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_client_id_phone_key" UNIQUE ("client_id", "phone");



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dead_letter_queue"
    ADD CONSTRAINT "dead_letter_queue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deals"
    ADD CONSTRAINT "deals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."discovery_run_metrics"
    ADD CONSTRAINT "discovery_run_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."distributed_locks"
    ADD CONSTRAINT "distributed_locks_pkey" PRIMARY KEY ("lock_key");



ALTER TABLE ONLY "public"."dm_queue"
    ADD CONSTRAINT "dm_queue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."emails"
    ADD CONSTRAINT "emails_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."emails"
    ADD CONSTRAINT "emails_resend_id_key" UNIQUE ("resend_id");



ALTER TABLE ONLY "public"."escalations"
    ADD CONSTRAINT "escalations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."exhausted_queries"
    ADD CONSTRAINT "exhausted_queries_pkey" PRIMARY KEY ("query");



ALTER TABLE ONLY "public"."follow_ups"
    ADD CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inbound_receipts"
    ADD CONSTRAINT "inbound_receipts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inbound_receipts"
    ADD CONSTRAINT "inbound_receipts_receipt_key_key" UNIQUE ("receipt_key");



ALTER TABLE ONLY "public"."knowledge_base"
    ADD CONSTRAINT "knowledge_base_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lead_data_quality_flags"
    ADD CONSTRAINT "lead_data_quality_flags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."recipient_outreach_ownership"
    ADD CONSTRAINT "recipient_outreach_ownership_pkey" PRIMARY KEY ("normalized_email");



ALTER TABLE ONLY "public"."search_cache"
    ADD CONSTRAINT "search_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."settings"
    ADD CONSTRAINT "settings_key_key" UNIQUE ("key");



ALTER TABLE ONLY "public"."settings"
    ADD CONSTRAINT "settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."weekly_reports"
    ADD CONSTRAINT "weekly_reports_client_id_week_start_key" UNIQUE ("client_id", "week_start");



ALTER TABLE ONLY "public"."weekly_reports"
    ADD CONSTRAINT "weekly_reports_pkey" PRIMARY KEY ("id");



CREATE INDEX "activity_log_delivery_email_created_at_idx" ON "public"."activity_log" USING "btree" ((("metadata" ->> 'email_id'::"text")), "created_at" DESC) WHERE ("event_type" = 'delivery_terminal_failure'::"text");



CREATE INDEX "activity_log_event_type_created_at_idx" ON "public"."activity_log" USING "btree" ("event_type", "created_at" DESC);



CREATE UNIQUE INDEX "activity_log_inbound_receipt_event_key" ON "public"."activity_log" USING "btree" ("event_type", (("metadata" ->> 'inbound_receipt_id'::"text"))) WHERE (("metadata" ->> 'inbound_receipt_id'::"text") IS NOT NULL);



CREATE INDEX "activity_log_lead_id_created_at_idx" ON "public"."activity_log" USING "btree" ("lead_id", "created_at" DESC);



CREATE INDEX "ai_models_provider_enabled_idx" ON "public"."ai_models" USING "btree" ("provider_id") WHERE ("enabled" = true);



CREATE INDEX "ai_request_logs_created_at_idx" ON "public"."ai_request_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "ai_request_logs_provider_created_at_idx" ON "public"."ai_request_logs" USING "btree" ("provider", "created_at" DESC);



CREATE INDEX "ai_request_logs_status_created_at_idx" ON "public"."ai_request_logs" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "ai_request_logs_workflow_created_at_idx" ON "public"."ai_request_logs" USING "btree" ("workflow", "created_at" DESC);



CREATE UNIQUE INDEX "categories_name_trimmed_lower_key" ON "public"."categories" USING "btree" ("lower"("btrim"("name")));



CREATE INDEX "category_email_templates_type_idx" ON "public"."category_email_templates" USING "btree" ("template_type");



CREATE INDEX "category_suburb_priorities_city_suburb_idx" ON "public"."category_suburb_priorities" USING "btree" ("city_suburb_id");



CREATE INDEX "category_suburb_search_state_city_suburb_idx" ON "public"."category_suburb_search_state" USING "btree" ("city_suburb_id");



CREATE INDEX "discovery_run_metrics_run_at_idx" ON "public"."discovery_run_metrics" USING "btree" ("run_at" DESC);



CREATE INDEX "dm_queue_handle_trgm_idx" ON "public"."dm_queue" USING "gin" ("handle" "public"."gin_trgm_ops");



CREATE INDEX "emails_created_at_id_idx" ON "public"."emails" USING "btree" ("created_at" DESC, "id");



CREATE INDEX "emails_lead_id_created_at_idx" ON "public"."emails" USING "btree" ("lead_id", "created_at");



CREATE UNIQUE INDEX "emails_lead_type_delivered_key" ON "public"."emails" USING "btree" ("lead_id", "type") WHERE ("status" = ANY (ARRAY['sent'::"text", 'email_sync_failed'::"text"]));



CREATE INDEX "emails_message_id_not_null_idx" ON "public"."emails" USING "btree" ("message_id") WHERE ("message_id" IS NOT NULL);



CREATE UNIQUE INDEX "emails_one_pending_initial_per_lead_key" ON "public"."emails" USING "btree" ("lead_id") WHERE (("type" = 'initial_pitch'::"text") AND ("status" = 'pending_send'::"text"));



CREATE INDEX "emails_replied_at_idx" ON "public"."emails" USING "btree" ("replied_at" DESC) WHERE ("replied_at" IS NOT NULL);



CREATE INDEX "emails_status_created_at_id_idx" ON "public"."emails" USING "btree" ("status", "created_at" DESC, "id");



CREATE INDEX "emails_status_sent_at_idx" ON "public"."emails" USING "btree" ("status", "sent_at" DESC) WHERE ("sent_at" IS NOT NULL);



CREATE INDEX "emails_subject_trgm_idx" ON "public"."emails" USING "gin" ("subject" "public"."gin_trgm_ops");



CREATE INDEX "emails_type_created_at_id_idx" ON "public"."emails" USING "btree" ("type", "created_at" DESC, "id");



CREATE INDEX "idx_bookings_client_id" ON "public"."bookings" USING "btree" ("client_id");



CREATE INDEX "idx_bookings_customer_id" ON "public"."bookings" USING "btree" ("customer_id");



CREATE INDEX "idx_bookings_date" ON "public"."bookings" USING "btree" ("client_id", "booking_date");



CREATE INDEX "idx_bookings_reminder" ON "public"."bookings" USING "btree" ("booking_date", "reminder_sent") WHERE (("status" = 'confirmed'::"text") AND ("reminder_sent" = false));



CREATE INDEX "idx_bookings_status" ON "public"."bookings" USING "btree" ("client_id", "status");



CREATE INDEX "idx_clients_business_type" ON "public"."clients" USING "btree" ("business_type");



CREATE INDEX "idx_clients_owner_email" ON "public"."clients" USING "btree" ("owner_email");



CREATE INDEX "idx_clients_plan" ON "public"."clients" USING "btree" ("plan");



CREATE INDEX "idx_clients_trial_ends" ON "public"."clients" USING "btree" ("trial_ends_at") WHERE ("plan" = 'trial'::"text");



CREATE INDEX "idx_conv_client_customer" ON "public"."conversations" USING "btree" ("client_id", "customer_id", "sent_at" DESC);



CREATE INDEX "idx_conv_client_id" ON "public"."conversations" USING "btree" ("client_id");



CREATE INDEX "idx_conv_customer_id" ON "public"."conversations" USING "btree" ("customer_id");



CREATE INDEX "idx_conv_intent" ON "public"."conversations" USING "btree" ("client_id", "intent");



CREATE INDEX "idx_conv_message_trgm" ON "public"."conversations" USING "gin" ("message_text" "public"."gin_trgm_ops");



CREATE INDEX "idx_conv_sent_at" ON "public"."conversations" USING "btree" ("sent_at" DESC);



CREATE UNIQUE INDEX "idx_conv_unique_whatsapp_msg" ON "public"."conversations" USING "btree" ("whatsapp_message_id") WHERE ("whatsapp_message_id" IS NOT NULL);



CREATE INDEX "idx_conv_whatsapp_msg_id" ON "public"."conversations" USING "btree" ("whatsapp_message_id") WHERE ("whatsapp_message_id" IS NOT NULL);



CREATE INDEX "idx_customers_client_id" ON "public"."customers" USING "btree" ("client_id");



CREATE INDEX "idx_customers_client_phone" ON "public"."customers" USING "btree" ("client_id", "phone");



CREATE INDEX "idx_customers_phone" ON "public"."customers" USING "btree" ("phone");



CREATE INDEX "idx_escalations_client_id" ON "public"."escalations" USING "btree" ("client_id");



CREATE INDEX "idx_escalations_unresolved" ON "public"."escalations" USING "btree" ("client_id", "resolved", "created_at" DESC) WHERE ("resolved" = false);



CREATE INDEX "idx_kb_active" ON "public"."knowledge_base" USING "btree" ("client_id", "is_active") WHERE ("is_active" = true);



CREATE INDEX "idx_kb_client_category" ON "public"."knowledge_base" USING "btree" ("client_id", "category");



CREATE INDEX "idx_kb_client_id" ON "public"."knowledge_base" USING "btree" ("client_id");



CREATE INDEX "idx_reports_client_id" ON "public"."weekly_reports" USING "btree" ("client_id");



CREATE INDEX "idx_reports_unsent" ON "public"."weekly_reports" USING "btree" ("report_sent", "week_start") WHERE ("report_sent" = false);



CREATE INDEX "idx_reports_week_start" ON "public"."weekly_reports" USING "btree" ("client_id", "week_start" DESC);



CREATE INDEX "inbound_receipts_status_updated_at_idx" ON "public"."inbound_receipts" USING "btree" ("status", "updated_at");



CREATE INDEX "lead_data_quality_flags_email_idx" ON "public"."lead_data_quality_flags" USING "btree" ("normalized_email", "issue_type") WHERE ("status" = 'open'::"text");



CREATE UNIQUE INDEX "lead_data_quality_flags_open_key" ON "public"."lead_data_quality_flags" USING "btree" ("lead_id", "issue_type", COALESCE("normalized_email", ''::"text")) WHERE ("status" = 'open'::"text");



CREATE INDEX "lead_data_quality_flags_status_updated_idx" ON "public"."lead_data_quality_flags" USING "btree" ("status", "updated_at" DESC);



CREATE INDEX "leads_business_name_trgm_idx" ON "public"."leads" USING "gin" ("business_name" "public"."gin_trgm_ops");



CREATE INDEX "leads_city_status_created_at_idx" ON "public"."leads" USING "btree" ("city", "status", "created_at" DESC);



CREATE INDEX "leads_email_report_address_idx" ON "public"."leads" USING "btree" ("lower"("btrim"("email"))) WHERE ("email" IS NOT NULL);



CREATE INDEX "leads_email_report_domain_idx" ON "public"."leads" USING "btree" ("lower"("btrim"("split_part"("btrim"("email"), '@'::"text", 2)))) WHERE (("email" IS NOT NULL) AND (POSITION(('@'::"text") IN ("btrim"("email"))) > 1));



CREATE INDEX "leads_email_trgm_idx" ON "public"."leads" USING "gin" ("email" "public"."gin_trgm_ops") WHERE ("email" IS NOT NULL);



CREATE INDEX "leads_normalized_email_idx" ON "public"."leads" USING "btree" ("normalized_email") WHERE ("normalized_email" IS NOT NULL);



CREATE INDEX "leads_status_created_at_idx" ON "public"."leads" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "profiles_is_active_idx" ON "public"."profiles" USING "btree" ("is_active");



CREATE INDEX "profiles_role_idx" ON "public"."profiles" USING "btree" ("role");



CREATE INDEX "recipient_outreach_owner_lead_idx" ON "public"."recipient_outreach_ownership" USING "btree" ("owner_lead_id") WHERE ("owner_lead_id" IS NOT NULL);



CREATE UNIQUE INDEX "search_cache_query_idx" ON "public"."search_cache" USING "btree" ("query");



CREATE OR REPLACE TRIGGER "leads_clear_outreach_suppression_on_email_change" AFTER UPDATE OF "email" ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."clear_lead_outreach_suppression_on_email_change"();



CREATE OR REPLACE TRIGGER "leads_refresh_data_quality" AFTER INSERT OR UPDATE OF "email", "business_name", "website", "phone", "address", "suburb", "instagram_handle" ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_refresh_lead_data_quality"();



CREATE OR REPLACE TRIGGER "leads_set_normalized_email" BEFORE INSERT OR UPDATE OF "email" ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."set_lead_normalized_email"();



CREATE OR REPLACE TRIGGER "normalize_lead_fields_trigger" BEFORE INSERT OR UPDATE OF "business_name", "email" ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."normalize_lead_fields"();



CREATE OR REPLACE TRIGGER "trg_bookings_updated_at" BEFORE UPDATE ON "public"."bookings" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_clients_updated_at" BEFORE UPDATE ON "public"."clients" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_conv_update_customer" AFTER INSERT ON "public"."conversations" FOR EACH ROW WHEN (("new"."role" = 'user'::"text")) EXECUTE FUNCTION "public"."update_customer_on_message"();



CREATE OR REPLACE TRIGGER "trg_kb_updated_at" BEFORE UPDATE ON "public"."knowledge_base" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "update_ai_models_updated_at" BEFORE UPDATE ON "public"."ai_models" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_ai_providers_updated_at" BEFORE UPDATE ON "public"."ai_providers" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_ai_workflow_configurations_updated_at" BEFORE UPDATE ON "public"."ai_workflow_configurations" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_categories_updated_at" BEFORE UPDATE ON "public"."categories" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_category_email_templates_updated_at" BEFORE UPDATE ON "public"."category_email_templates" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_category_suburb_priorities_updated_at" BEFORE UPDATE ON "public"."category_suburb_priorities" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_category_suburb_search_state_updated_at" BEFORE UPDATE ON "public"."category_suburb_search_state" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_leads_updated_at" BEFORE UPDATE ON "public"."leads" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_settings_updated_at" BEFORE UPDATE ON "public"."settings" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



ALTER TABLE ONLY "public"."activity_log"
    ADD CONSTRAINT "activity_log_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_models"
    ADD CONSTRAINT "ai_models_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_workflow_configurations"
    ADD CONSTRAINT "ai_workflow_configurations_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id");



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."category_email_templates"
    ADD CONSTRAINT "category_email_templates_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."category_suburb_priorities"
    ADD CONSTRAINT "category_suburb_priorities_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."category_suburb_priorities"
    ADD CONSTRAINT "category_suburb_priorities_city_suburb_id_fkey" FOREIGN KEY ("city_suburb_id") REFERENCES "public"."city_suburbs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."category_suburb_search_state"
    ADD CONSTRAINT "category_suburb_search_state_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."category_suburb_search_state"
    ADD CONSTRAINT "category_suburb_search_state_city_suburb_id_fkey" FOREIGN KEY ("city_suburb_id") REFERENCES "public"."city_suburbs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deals"
    ADD CONSTRAINT "deals_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dm_queue"
    ADD CONSTRAINT "dm_queue_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."emails"
    ADD CONSTRAINT "emails_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."escalations"
    ADD CONSTRAINT "escalations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."escalations"
    ADD CONSTRAINT "escalations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id");



ALTER TABLE ONLY "public"."escalations"
    ADD CONSTRAINT "escalations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."follow_ups"
    ADD CONSTRAINT "follow_ups_email_id_fkey" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id");



ALTER TABLE ONLY "public"."follow_ups"
    ADD CONSTRAINT "follow_ups_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."knowledge_base"
    ADD CONSTRAINT "knowledge_base_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_data_quality_flags"
    ADD CONSTRAINT "lead_data_quality_flags_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lead_data_quality_flags"
    ADD CONSTRAINT "lead_data_quality_flags_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."leads"
    ADD CONSTRAINT "leads_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."recipient_outreach_ownership"
    ADD CONSTRAINT "recipient_outreach_ownership_owner_lead_id_fkey" FOREIGN KEY ("owner_lead_id") REFERENCES "public"."leads"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."weekly_reports"
    ADD CONSTRAINT "weekly_reports_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE CASCADE;



CREATE POLICY "Admins can manage" ON "public"."ai_models" TO "authenticated" USING ("public"."is_active_admin"()) WITH CHECK ("public"."is_active_admin"());



CREATE POLICY "Admins can manage" ON "public"."ai_providers" TO "authenticated" USING ("public"."is_active_admin"()) WITH CHECK ("public"."is_active_admin"());



CREATE POLICY "Admins can manage" ON "public"."ai_workflow_configurations" TO "authenticated" USING ("public"."is_active_admin"()) WITH CHECK ("public"."is_active_admin"());



CREATE POLICY "Admins can manage" ON "public"."category_email_templates" TO "authenticated" USING ("public"."is_active_admin"()) WITH CHECK ("public"."is_active_admin"());



CREATE POLICY "Admins can manage" ON "public"."category_suburb_priorities" TO "authenticated" USING ("public"."is_active_admin"()) WITH CHECK ("public"."is_active_admin"());



CREATE POLICY "Admins can manage" ON "public"."category_suburb_search_state" TO "authenticated" USING ("public"."is_active_admin"()) WITH CHECK ("public"."is_active_admin"());



CREATE POLICY "Admins can read AI request logs" ON "public"."ai_request_logs" FOR SELECT TO "authenticated" USING ("public"."is_active_admin"());



CREATE POLICY "Admins can read all profiles" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text") AND ("p"."is_active" = true)))));



CREATE POLICY "Authenticated users can read" ON "public"."ai_models" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read" ON "public"."ai_providers" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read" ON "public"."ai_workflow_configurations" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read" ON "public"."category_email_templates" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read" ON "public"."category_suburb_priorities" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read" ON "public"."category_suburb_search_state" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read data quality flags" ON "public"."lead_data_quality_flags" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read recipient ownership" ON "public"."recipient_outreach_ownership" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users have full access" ON "public"."activity_log" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users have full access" ON "public"."categories" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users have full access" ON "public"."dead_letter_queue" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users have full access" ON "public"."deals" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users have full access" ON "public"."dm_queue" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users have full access" ON "public"."emails" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users have full access" ON "public"."exhausted_queries" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users have full access" ON "public"."follow_ups" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users have full access" ON "public"."leads" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users have full access" ON "public"."search_cache" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Authenticated users have full access" ON "public"."settings" TO "authenticated" USING (true) WITH CHECK (true);



CREATE POLICY "Service role bypass" ON "public"."activity_log" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role bypass" ON "public"."ai_models" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role bypass" ON "public"."ai_providers" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role bypass" ON "public"."ai_workflow_configurations" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role bypass" ON "public"."categories" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role bypass" ON "public"."dead_letter_queue" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role bypass" ON "public"."deals" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role bypass" ON "public"."dm_queue" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role bypass" ON "public"."emails" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role bypass" ON "public"."exhausted_queries" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role bypass" ON "public"."follow_ups" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role bypass" ON "public"."leads" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role bypass" ON "public"."search_cache" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role bypass" ON "public"."settings" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role can manage" ON "public"."category_email_templates" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role can manage" ON "public"."category_suburb_priorities" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role can manage" ON "public"."category_suburb_search_state" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role can manage AI request logs" ON "public"."ai_request_logs" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role manages data quality flags" ON "public"."lead_data_quality_flags" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role manages inbound receipts" ON "public"."inbound_receipts" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role manages profiles" ON "public"."profiles" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service role manages recipient ownership" ON "public"."recipient_outreach_ownership" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Users can read own profile" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can view own profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));



ALTER TABLE "public"."activity_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_models" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_providers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_request_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_workflow_configurations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bookings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bookings_client_scoped" ON "public"."bookings" USING (("client_id" = "auth"."uid"()));



ALTER TABLE "public"."categories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."category_email_templates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."category_suburb_priorities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."category_suburb_search_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clients" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "clients_own_record" ON "public"."clients" USING (("id" = "auth"."uid"()));



ALTER TABLE "public"."conversations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "conversations_client_scoped" ON "public"."conversations" USING (("client_id" = "auth"."uid"()));



ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customers_client_scoped" ON "public"."customers" USING (("client_id" = "auth"."uid"()));



ALTER TABLE "public"."dead_letter_queue" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."discovery_run_metrics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dm_queue" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."emails" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."escalations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "escalations_client_scoped" ON "public"."escalations" USING (("client_id" = "auth"."uid"()));



ALTER TABLE "public"."exhausted_queries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."follow_ups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inbound_receipts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "kb_client_scoped" ON "public"."knowledge_base" USING (("client_id" = "auth"."uid"()));



ALTER TABLE "public"."knowledge_base" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lead_data_quality_flags" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."leads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."recipient_outreach_ownership" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reports_client_scoped" ON "public"."weekly_reports" USING (("client_id" = "auth"."uid"()));



ALTER TABLE "public"."search_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."weekly_reports" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "extensions" TO "anon";
GRANT USAGE ON SCHEMA "extensions" TO "authenticated";
GRANT USAGE ON SCHEMA "extensions" TO "service_role";
GRANT ALL ON SCHEMA "extensions" TO "dashboard_user";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "extensions"."grant_pg_cron_access"() FROM "supabase_admin";
GRANT ALL ON FUNCTION "extensions"."grant_pg_cron_access"() TO "supabase_admin" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."grant_pg_cron_access"() TO "dashboard_user";



GRANT ALL ON FUNCTION "extensions"."grant_pg_graphql_access"() TO "postgres" WITH GRANT OPTION;



REVOKE ALL ON FUNCTION "extensions"."grant_pg_net_access"() FROM "supabase_admin";
GRANT ALL ON FUNCTION "extensions"."grant_pg_net_access"() TO "supabase_admin" WITH GRANT OPTION;
GRANT ALL ON FUNCTION "extensions"."grant_pg_net_access"() TO "dashboard_user";



GRANT ALL ON FUNCTION "extensions"."pgrst_ddl_watch"() TO "postgres" WITH GRANT OPTION;



GRANT ALL ON FUNCTION "extensions"."pgrst_drop_watch"() TO "postgres" WITH GRANT OPTION;



GRANT ALL ON FUNCTION "extensions"."set_graphql_placeholder"() TO "postgres" WITH GRANT OPTION;



REVOKE ALL ON FUNCTION "public"."claim_hostinger_inbound_receipt"("p_receipt_id" "uuid", "p_run_id" "text", "p_stale_before" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_hostinger_inbound_receipt"("p_receipt_id" "uuid", "p_run_id" "text", "p_stale_before" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_recipient_outreach"("p_lead_id" "uuid", "p_phase" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."claim_recipient_outreach"("p_lead_id" "uuid", "p_phase" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_recipient_outreach"("p_lead_id" "uuid", "p_phase" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."classify_data_quality_group"("p_leads" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."classify_data_quality_group"("p_leads" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."classify_data_quality_group"("p_leads" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."classify_email_quality"("p_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."classify_email_quality"("p_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."classify_email_quality"("p_email" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."clear_lead_outreach_suppression_on_email_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."clear_lead_outreach_suppression_on_email_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."clear_lead_outreach_suppression_on_email_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."data_quality_compact_identity"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."data_quality_compact_identity"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."data_quality_compact_identity"("p_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."data_quality_meaningful_website_identity"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."data_quality_meaningful_website_identity"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."data_quality_meaningful_website_identity"("p_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."data_quality_phone_identity"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."data_quality_phone_identity"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."data_quality_phone_identity"("p_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."data_quality_present"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."data_quality_present"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."data_quality_present"("p_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."data_quality_social_identity"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."data_quality_social_identity"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."data_quality_social_identity"("p_value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."data_quality_website_identity"("p_value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."data_quality_website_identity"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."data_quality_website_identity"("p_value" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_ai_request_analytics"("p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_workflow" "text", "p_provider" "text", "p_status" "text", "p_recent_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_ai_request_analytics"("p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_workflow" "text", "p_provider" "text", "p_status" "text", "p_recent_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_ai_request_analytics"("p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_workflow" "text", "p_provider" "text", "p_status" "text", "p_recent_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_ai_request_analytics"("p_start_at" timestamp with time zone, "p_end_at" timestamp with time zone, "p_workflow" "text", "p_provider" "text", "p_status" "text", "p_recent_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_dashboard_summary"("p_as_of" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_dashboard_summary"("p_as_of" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."get_dashboard_summary"("p_as_of" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_dashboard_summary"("p_as_of" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_data_quality_report"("p_issue_type" "text", "p_email" "text", "p_business" "text", "p_category" "text", "p_city" "text", "p_page" integer, "p_page_size" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_data_quality_report"("p_issue_type" "text", "p_email" "text", "p_business" "text", "p_category" "text", "p_city" "text", "p_page" integer, "p_page_size" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_data_quality_report"("p_issue_type" "text", "p_email" "text", "p_business" "text", "p_category" "text", "p_city" "text", "p_page" integer, "p_page_size" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_data_quality_report_v2"("p_issue_type" "text", "p_search" "text", "p_email" "text", "p_business" "text", "p_category" "text", "p_city" "text", "p_page" integer, "p_page_size" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_data_quality_report_v2"("p_issue_type" "text", "p_search" "text", "p_email" "text", "p_business" "text", "p_category" "text", "p_city" "text", "p_page" integer, "p_page_size" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_data_quality_report_v2"("p_issue_type" "text", "p_search" "text", "p_email" "text", "p_business" "text", "p_category" "text", "p_city" "text", "p_page" integer, "p_page_size" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_data_quality_summary"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_data_quality_summary"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_data_quality_summary"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_deals_search_page"("p_search" "text", "p_page" integer, "p_page_size" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_deals_search_page"("p_search" "text", "p_page" integer, "p_page_size" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_deals_search_page"("p_search" "text", "p_page" integer, "p_page_size" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_deals_search_page"("p_search" "text", "p_page" integer, "p_page_size" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_delivery_failure_lead_selection"("p_status" "text", "p_email_type" "text", "p_search" "text", "p_include_ids" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_delivery_failure_lead_selection"("p_status" "text", "p_email_type" "text", "p_search" "text", "p_include_ids" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."get_delivery_failure_lead_selection"("p_status" "text", "p_email_type" "text", "p_search" "text", "p_include_ids" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_delivery_failure_lead_selection"("p_status" "text", "p_email_type" "text", "p_search" "text", "p_include_ids" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_delivery_failure_report"("p_status" "text", "p_email_type" "text", "p_search" "text", "p_page" integer, "p_page_size" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_delivery_failure_report"("p_status" "text", "p_email_type" "text", "p_search" "text", "p_page" integer, "p_page_size" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_delivery_failure_report"("p_status" "text", "p_email_type" "text", "p_search" "text", "p_page" integer, "p_page_size" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_delivery_failure_report"("p_status" "text", "p_email_type" "text", "p_search" "text", "p_page" integer, "p_page_size" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_dm_queue_search_page"("p_status" "text", "p_platform" "text", "p_city" "text", "p_search" "text", "p_page" integer, "p_page_size" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_dm_queue_search_page"("p_status" "text", "p_platform" "text", "p_city" "text", "p_search" "text", "p_page" integer, "p_page_size" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_dm_queue_search_page"("p_status" "text", "p_platform" "text", "p_city" "text", "p_search" "text", "p_page" integer, "p_page_size" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_dm_queue_search_page"("p_status" "text", "p_platform" "text", "p_city" "text", "p_search" "text", "p_page" integer, "p_page_size" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_email_log_search_page"("p_type" "text", "p_status" "text", "p_search" "text", "p_page" integer, "p_page_size" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_email_log_search_page"("p_type" "text", "p_status" "text", "p_search" "text", "p_page" integer, "p_page_size" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_email_log_search_page"("p_type" "text", "p_status" "text", "p_search" "text", "p_page" integer, "p_page_size" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_email_log_search_page"("p_type" "text", "p_status" "text", "p_search" "text", "p_page" integer, "p_page_size" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_email_log_summary"("p_type" "text", "p_status" "text", "p_search" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_email_log_summary"("p_type" "text", "p_status" "text", "p_search" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_email_log_summary"("p_type" "text", "p_status" "text", "p_search" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_email_log_summary"("p_type" "text", "p_status" "text", "p_search" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_email_report_leads"("p_addresses" "text"[], "p_domains" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_email_report_leads"("p_addresses" "text"[], "p_domains" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_email_report_leads"("p_addresses" "text"[], "p_domains" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_email_report_leads"("p_addresses" "text"[], "p_domains" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_health_summary"("p_as_of" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_health_summary"("p_as_of" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."get_health_summary"("p_as_of" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_health_summary"("p_as_of" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_lead_status_counts"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_lead_status_counts"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_lead_status_counts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_lead_status_counts"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_leads_search_page"("p_statuses" "text"[], "p_category" "text", "p_city" "text", "p_search" "text", "p_page" integer, "p_page_size" integer, "p_ids_only" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_leads_search_page"("p_statuses" "text"[], "p_category" "text", "p_city" "text", "p_search" "text", "p_page" integer, "p_page_size" integer, "p_ids_only" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."get_leads_search_page"("p_statuses" "text"[], "p_category" "text", "p_city" "text", "p_search" "text", "p_page" integer, "p_page_size" integer, "p_ids_only" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_leads_search_page"("p_statuses" "text"[], "p_category" "text", "p_city" "text", "p_search" "text", "p_page" integer, "p_page_size" integer, "p_ids_only" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_lifecycle_page"("p_as_of" timestamp with time zone, "p_filter" "text", "p_search" "text", "p_sort_key" "text", "p_sort_dir" "text", "p_page" integer, "p_page_size" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_lifecycle_page"("p_as_of" timestamp with time zone, "p_filter" "text", "p_search" "text", "p_sort_key" "text", "p_sort_dir" "text", "p_page" integer, "p_page_size" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_lifecycle_page"("p_as_of" timestamp with time zone, "p_filter" "text", "p_search" "text", "p_sort_key" "text", "p_sort_dir" "text", "p_page" integer, "p_page_size" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_lifecycle_page"("p_as_of" timestamp with time zone, "p_filter" "text", "p_search" "text", "p_sort_key" "text", "p_sort_dir" "text", "p_page" integer, "p_page_size" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_pipeline_search_page"("p_statuses" "text"[], "p_search" "text", "p_page" integer, "p_page_size" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_pipeline_search_page"("p_statuses" "text"[], "p_search" "text", "p_page" integer, "p_page_size" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_pipeline_search_page"("p_statuses" "text"[], "p_search" "text", "p_page" integer, "p_page_size" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_pipeline_search_page"("p_statuses" "text"[], "p_search" "text", "p_page" integer, "p_page_size" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_active_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_active_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_active_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_active_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."literal_ilike_pattern"("p_search" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."literal_ilike_pattern"("p_search" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."literal_ilike_pattern"("p_search" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."literal_ilike_pattern"("p_search" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_lead_fields"() TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_lead_fields"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_lead_fields"() TO "service_role";



GRANT ALL ON FUNCTION "public"."refresh_email_group_quality"("p_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_email_group_quality"("p_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_email_group_quality"("p_email" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."refresh_lead_data_quality"("p_lead_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_lead_data_quality"("p_lead_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_lead_data_quality"("p_lead_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_recipient_outreach_claim"("p_lead_id" "uuid", "p_normalized_email" "text", "p_claim_token" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_recipient_outreach_claim"("p_lead_id" "uuid", "p_normalized_email" "text", "p_claim_token" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."release_recipient_outreach_claim"("p_lead_id" "uuid", "p_normalized_email" "text", "p_claim_token" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."remove_data_quality_emails"("p_lead_ids" "uuid"[], "p_actor_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."remove_data_quality_emails"("p_lead_ids" "uuid"[], "p_actor_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."remove_data_quality_emails"("p_lead_ids" "uuid"[], "p_actor_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_data_quality_flag_status"("p_issue_type" "text", "p_normalized_email" "text", "p_lead_ids" "uuid"[], "p_status" "text", "p_resolution_reason" "text", "p_actor_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_data_quality_flag_status"("p_issue_type" "text", "p_normalized_email" "text", "p_lead_ids" "uuid"[], "p_status" "text", "p_resolution_reason" "text", "p_actor_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."set_data_quality_flag_status"("p_issue_type" "text", "p_normalized_email" "text", "p_lead_ids" "uuid"[], "p_status" "text", "p_resolution_reason" "text", "p_actor_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_lead_normalized_email"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_lead_normalized_email"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_lead_normalized_email"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."suppress_lead_delivery_email"("p_lead_id" "uuid", "p_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."suppress_lead_delivery_email"("p_lead_id" "uuid", "p_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."suppress_lead_delivery_email"("p_lead_id" "uuid", "p_email" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_refresh_lead_data_quality"() TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_refresh_lead_data_quality"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_refresh_lead_data_quality"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_customer_on_message"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_customer_on_message"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_customer_on_message"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



GRANT ALL ON TABLE "public"."activity_log" TO "anon";
GRANT ALL ON TABLE "public"."activity_log" TO "authenticated";
GRANT ALL ON TABLE "public"."activity_log" TO "service_role";



GRANT ALL ON TABLE "public"."ai_models" TO "anon";
GRANT ALL ON TABLE "public"."ai_models" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_models" TO "service_role";



GRANT ALL ON TABLE "public"."ai_providers" TO "anon";
GRANT ALL ON TABLE "public"."ai_providers" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_providers" TO "service_role";



GRANT ALL ON TABLE "public"."ai_request_logs" TO "anon";
GRANT ALL ON TABLE "public"."ai_request_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_request_logs" TO "service_role";



GRANT ALL ON TABLE "public"."ai_workflow_configurations" TO "anon";
GRANT ALL ON TABLE "public"."ai_workflow_configurations" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_workflow_configurations" TO "service_role";



GRANT ALL ON TABLE "public"."bookings" TO "anon";
GRANT ALL ON TABLE "public"."bookings" TO "authenticated";
GRANT ALL ON TABLE "public"."bookings" TO "service_role";



GRANT ALL ON TABLE "public"."categories" TO "anon";
GRANT ALL ON TABLE "public"."categories" TO "authenticated";
GRANT ALL ON TABLE "public"."categories" TO "service_role";



GRANT ALL ON TABLE "public"."category_email_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."category_email_templates" TO "service_role";



GRANT ALL ON TABLE "public"."category_suburb_priorities" TO "authenticated";
GRANT ALL ON TABLE "public"."category_suburb_priorities" TO "service_role";



GRANT ALL ON TABLE "public"."category_suburb_search_state" TO "authenticated";
GRANT ALL ON TABLE "public"."category_suburb_search_state" TO "service_role";



GRANT ALL ON TABLE "public"."city_suburbs" TO "anon";
GRANT ALL ON TABLE "public"."city_suburbs" TO "authenticated";
GRANT ALL ON TABLE "public"."city_suburbs" TO "service_role";



GRANT ALL ON TABLE "public"."clients" TO "anon";
GRANT ALL ON TABLE "public"."clients" TO "authenticated";
GRANT ALL ON TABLE "public"."clients" TO "service_role";



GRANT ALL ON TABLE "public"."conversations" TO "anon";
GRANT ALL ON TABLE "public"."conversations" TO "authenticated";
GRANT ALL ON TABLE "public"."conversations" TO "service_role";



GRANT ALL ON TABLE "public"."customers" TO "anon";
GRANT ALL ON TABLE "public"."customers" TO "authenticated";
GRANT ALL ON TABLE "public"."customers" TO "service_role";



GRANT ALL ON TABLE "public"."dead_letter_queue" TO "anon";
GRANT ALL ON TABLE "public"."dead_letter_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."dead_letter_queue" TO "service_role";



GRANT ALL ON TABLE "public"."deals" TO "anon";
GRANT ALL ON TABLE "public"."deals" TO "authenticated";
GRANT ALL ON TABLE "public"."deals" TO "service_role";



GRANT ALL ON TABLE "public"."discovery_run_metrics" TO "anon";
GRANT ALL ON TABLE "public"."discovery_run_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."discovery_run_metrics" TO "service_role";



GRANT ALL ON TABLE "public"."distributed_locks" TO "anon";
GRANT ALL ON TABLE "public"."distributed_locks" TO "authenticated";
GRANT ALL ON TABLE "public"."distributed_locks" TO "service_role";



GRANT ALL ON TABLE "public"."dm_queue" TO "anon";
GRANT ALL ON TABLE "public"."dm_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."dm_queue" TO "service_role";



GRANT ALL ON TABLE "public"."emails" TO "anon";
GRANT ALL ON TABLE "public"."emails" TO "authenticated";
GRANT ALL ON TABLE "public"."emails" TO "service_role";



GRANT ALL ON TABLE "public"."escalations" TO "anon";
GRANT ALL ON TABLE "public"."escalations" TO "authenticated";
GRANT ALL ON TABLE "public"."escalations" TO "service_role";



GRANT ALL ON TABLE "public"."exhausted_queries" TO "anon";
GRANT ALL ON TABLE "public"."exhausted_queries" TO "authenticated";
GRANT ALL ON TABLE "public"."exhausted_queries" TO "service_role";



GRANT ALL ON TABLE "public"."follow_ups" TO "anon";
GRANT ALL ON TABLE "public"."follow_ups" TO "authenticated";
GRANT ALL ON TABLE "public"."follow_ups" TO "service_role";



GRANT ALL ON TABLE "public"."inbound_receipts" TO "anon";
GRANT ALL ON TABLE "public"."inbound_receipts" TO "authenticated";
GRANT ALL ON TABLE "public"."inbound_receipts" TO "service_role";



GRANT ALL ON TABLE "public"."knowledge_base" TO "anon";
GRANT ALL ON TABLE "public"."knowledge_base" TO "authenticated";
GRANT ALL ON TABLE "public"."knowledge_base" TO "service_role";



GRANT ALL ON TABLE "public"."lead_data_quality_flags" TO "anon";
GRANT ALL ON TABLE "public"."lead_data_quality_flags" TO "authenticated";
GRANT ALL ON TABLE "public"."lead_data_quality_flags" TO "service_role";



GRANT ALL ON TABLE "public"."leads" TO "anon";
GRANT ALL ON TABLE "public"."leads" TO "authenticated";
GRANT ALL ON TABLE "public"."leads" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."recipient_outreach_ownership" TO "anon";
GRANT ALL ON TABLE "public"."recipient_outreach_ownership" TO "authenticated";
GRANT ALL ON TABLE "public"."recipient_outreach_ownership" TO "service_role";



GRANT ALL ON TABLE "public"."search_cache" TO "anon";
GRANT ALL ON TABLE "public"."search_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."search_cache" TO "service_role";



GRANT ALL ON TABLE "public"."settings" TO "anon";
GRANT ALL ON TABLE "public"."settings" TO "authenticated";
GRANT ALL ON TABLE "public"."settings" TO "service_role";



GRANT ALL ON TABLE "public"."v_bookings_full" TO "anon";
GRANT ALL ON TABLE "public"."v_bookings_full" TO "authenticated";
GRANT ALL ON TABLE "public"."v_bookings_full" TO "service_role";



GRANT ALL ON TABLE "public"."v_conversation_thread" TO "anon";
GRANT ALL ON TABLE "public"."v_conversation_thread" TO "authenticated";
GRANT ALL ON TABLE "public"."v_conversation_thread" TO "service_role";



GRANT ALL ON TABLE "public"."v_daily_summary" TO "anon";
GRANT ALL ON TABLE "public"."v_daily_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."v_daily_summary" TO "service_role";



GRANT ALL ON TABLE "public"."weekly_reports" TO "anon";
GRANT ALL ON TABLE "public"."weekly_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."weekly_reports" TO "service_role";












ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";
