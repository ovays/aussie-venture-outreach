-- ReachAgent SaaS 8: platform administration and immutable audit trail.
--
-- Adds:
--   * public.audit_events          — durable append-only audit ledger
--   * public.write_audit_event()   — single trusted server-side audit writer
--   * platform workspace directory + workspace/membership administration RPCs
--   * deterministic role guardrails (last active owner, protected seed workspace)
--   * an audit mirror for SaaS 6 entitlement overrides (transactional)
--
-- The audit record is diagnostic/history, never authorization. Workspace_id may
-- be NULL for true platform-level events. Actor identity is resolved server-side
-- by the application and validated here; browsers have no INSERT/UPDATE/DELETE
-- grants on audit_events and no EXECUTE on any of these functions.

GRANT reachagent_function_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Append-only audit ledger
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_type text NOT NULL DEFAULT 'user',
  actor_role text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  result text NOT NULL DEFAULT 'success',
  request_id text,
  source text NOT NULL DEFAULT 'application',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_action_format
    CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  CONSTRAINT audit_events_actor_type_check
    CHECK (actor_type IN ('user', 'service_role', 'system')),
  CONSTRAINT audit_events_actor_role_check
    CHECK (actor_role IS NULL OR actor_role IN ('platform_admin', 'owner', 'admin', 'member')),
  CONSTRAINT audit_events_result_check
    CHECK (result IN ('success', 'failure', 'denied')),
  CONSTRAINT audit_events_target_type_bounded CHECK (length(target_type) BETWEEN 1 AND 120),
  CONSTRAINT audit_events_target_id_bounded CHECK (target_id IS NULL OR length(target_id) <= 200),
  CONSTRAINT audit_events_request_id_bounded CHECK (request_id IS NULL OR length(request_id) <= 200),
  CONSTRAINT audit_events_source_bounded CHECK (length(source) BETWEEN 1 AND 100)
);

ALTER TABLE public.audit_events OWNER TO postgres;

CREATE INDEX audit_events_workspace_created_idx
  ON public.audit_events (workspace_id, created_at DESC, id DESC);
CREATE INDEX audit_events_created_idx
  ON public.audit_events (created_at DESC, id DESC);
CREATE INDEX audit_events_actor_created_idx
  ON public.audit_events (actor_user_id, created_at DESC, id DESC);
CREATE INDEX audit_events_action_created_idx
  ON public.audit_events (action, created_at DESC, id DESC);

CREATE FUNCTION reachagent_private.reject_audit_event_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only' USING ERRCODE = '42501';
END
$$;

ALTER FUNCTION reachagent_private.reject_audit_event_mutation() OWNER TO reachagent_function_owner;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION reachagent_private.reject_audit_event_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- Metadata sanitization (defensive; the application sanitizes too)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION reachagent_private.sanitize_audit_metadata(p_value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_key text;
  v_item jsonb;
  v_out jsonb := '{}'::jsonb;
BEGIN
  IF p_value IS NULL OR p_value = 'null'::jsonb OR jsonb_typeof(p_value) = 'null' THEN
    RETURN p_value;
  END IF;

  IF jsonb_typeof(p_value) = 'array' THEN
    v_out := '[]'::jsonb;
    FOR v_item IN SELECT pg_catalog.jsonb_array_elements(p_value) LOOP
      v_out := v_out || reachagent_private.sanitize_audit_metadata(v_item);
    END LOOP;
    RETURN v_out;
  END IF;

  IF jsonb_typeof(p_value) <> 'object' THEN
    RETURN p_value;
  END IF;

  FOR v_key, v_item IN SELECT * FROM pg_catalog.jsonb_each(p_value) LOOP
    IF pg_catalog.lower(v_key) IN (
      'password', 'token', 'access_token', 'refresh_token', 'secret',
      'api_key', 'apikey', 'authorization', 'cookie', 'client_secret',
      'service_role', 'service_role_key', 'encryption_key', 'webhook_secret',
      'session', 'credential', 'credentials', 'private_key', 'payload',
      'raw_payload', 'request_body', 'response_body', 'oauth_payload',
      'stripe_payload', 'email_payload', 'accesstoken', 'refreshtoken',
      'clientsecret', 'servicerole', 'servicerolekey', 'encryptionkey',
      'webhooksecret', 'privatekey', 'rawpayload', 'requestbody',
      'responsebody', 'oauthpayload', 'stripepayload', 'emailpayload'
    ) THEN
      v_out := v_out || pg_catalog.jsonb_build_object(v_key, '[REDACTED]');
    ELSE
      v_out := v_out || pg_catalog.jsonb_build_object(v_key, reachagent_private.sanitize_audit_metadata(v_item));
    END IF;
  END LOOP;

  RETURN v_out;
END
$$;

ALTER FUNCTION reachagent_private.sanitize_audit_metadata(jsonb) OWNER TO reachagent_function_owner;

-- ─────────────────────────────────────────────────────────────────────────────
-- Central audit writer (service_role only)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION public.write_audit_event(
  p_workspace_id uuid DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL,
  p_actor_type text DEFAULT 'user',
  p_actor_role text DEFAULT NULL,
  p_action text DEFAULT NULL,
  p_target_type text DEFAULT NULL,
  p_target_id text DEFAULT NULL,
  p_result text DEFAULT 'success',
  p_request_id text DEFAULT NULL,
  p_source text DEFAULT 'application',
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
  v_id uuid;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  IF NULLIF(pg_catalog.btrim(p_action), '') IS NULL
     OR p_action !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' THEN
    RAISE EXCEPTION 'invalid audit action name' USING ERRCODE = '22023';
  END IF;
  IF p_actor_type NOT IN ('user', 'service_role', 'system') THEN
    RAISE EXCEPTION 'invalid actor_type' USING ERRCODE = '22023';
  END IF;
  IF p_actor_role IS NOT NULL AND p_actor_role NOT IN ('platform_admin', 'owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'invalid actor_role' USING ERRCODE = '22023';
  END IF;
  IF p_actor_type = 'user' THEN
    IF p_actor_user_id IS NULL OR p_actor_role IS NULL THEN
      RAISE EXCEPTION 'user audit actors require an id and role' USING ERRCODE = '22023';
    END IF;
    IF p_actor_role = 'platform_admin' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_actor_user_id AND role = 'admin' AND is_active = true
      ) THEN
        RAISE EXCEPTION 'invalid platform audit actor' USING ERRCODE = '42501';
      END IF;
    ELSIF p_workspace_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.workspace_members
      WHERE workspace_id = p_workspace_id AND user_id = p_actor_user_id
        AND role = p_actor_role AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'invalid workspace audit actor' USING ERRCODE = '42501';
    END IF;
  ELSIF p_actor_user_id IS NOT NULL OR p_actor_role IS NOT NULL THEN
    RAISE EXCEPTION 'non-user audit actors cannot claim a user or role' USING ERRCODE = '22023';
  END IF;
  IF p_result NOT IN ('success', 'failure', 'denied') THEN
    RAISE EXCEPTION 'invalid audit result' USING ERRCODE = '22023';
  END IF;
  IF NULLIF(pg_catalog.btrim(p_target_type), '') IS NULL THEN
    RAISE EXCEPTION 'target_type is required' USING ERRCODE = '22023';
  END IF;
  IF p_workspace_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = p_workspace_id) THEN
    RAISE EXCEPTION 'unknown workspace' USING ERRCODE = '22023';
  END IF;
  IF p_metadata IS NOT NULL AND pg_catalog.pg_column_size(p_metadata) > 8192 THEN
    RAISE EXCEPTION 'audit metadata exceeds size bound' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.audit_events (
    workspace_id, actor_user_id, actor_type, actor_role, action, target_type,
    target_id, result, request_id, source, metadata
  ) VALUES (
    p_workspace_id, p_actor_user_id, p_actor_type, p_actor_role, p_action,
    p_target_type, NULLIF(pg_catalog.btrim(p_target_id), ''), p_result,
    NULLIF(pg_catalog.btrim(p_request_id), ''), pg_catalog.btrim(p_source),
    reachagent_private.sanitize_audit_metadata(COALESCE(p_metadata, '{}'::jsonb))
  ) RETURNING id INTO v_id;

  RETURN v_id;
END
$$;

ALTER FUNCTION public.write_audit_event(
  uuid, uuid, text, text, text, text, text, text, text, text, jsonb
) OWNER TO reachagent_function_owner;

-- ─────────────────────────────────────────────────────────────────────────────
-- Guardrail helper: active owner count for a workspace
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION reachagent_private.workspace_active_owner_count(p_workspace_id uuid) RETURNS bigint
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT pg_catalog.count(*)
  FROM public.workspace_members
  WHERE workspace_id = p_workspace_id AND role = 'owner' AND status = 'active'
$$;

ALTER FUNCTION reachagent_private.workspace_active_owner_count(uuid) OWNER TO reachagent_function_owner;

CREATE FUNCTION reachagent_private.assert_admin_actor(
  p_workspace_id uuid,
  p_actor_id uuid,
  p_actor_role text,
  p_platform_only boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF p_actor_id IS NULL OR p_actor_role IS NULL THEN
    RAISE EXCEPTION 'actor identity is required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_role = 'platform_admin' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = p_actor_id AND role = 'admin' AND is_active = true
    ) THEN
      RAISE EXCEPTION 'platform admin actor required' USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;
  IF p_platform_only OR p_actor_role NOT IN ('owner', 'admin') OR p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'administrative actor required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = p_actor_id
      AND role = p_actor_role AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'workspace admin actor required' USING ERRCODE = '42501';
  END IF;
END
$$;

ALTER FUNCTION reachagent_private.assert_admin_actor(uuid, uuid, text, boolean)
  OWNER TO reachagent_function_owner;

-- ─────────────────────────────────────────────────────────────────────────────
-- Platform workspace directory (single bounded query)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION public.admin_list_workspace_directory()
RETURNS TABLE (
  id uuid,
  name text,
  slug text,
  status text,
  created_at timestamptz,
  member_count bigint,
  stored_leads bigint,
  mailbox_count bigint,
  plan_code text,
  plan_name text,
  billing_status text
)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
    SELECT
      w.id, w.name, w.slug, w.status, w.created_at,
      (SELECT pg_catalog.count(*) FROM public.workspace_members m
        WHERE m.workspace_id = w.id AND m.status = 'active') AS member_count,
      (SELECT pg_catalog.count(*) FROM public.leads l
        WHERE l.workspace_id = w.id) AS stored_leads,
      (SELECT pg_catalog.count(*) FROM public.mailbox_connections mc
        WHERE mc.workspace_id = w.id AND mc.status <> 'disconnected') AS mailbox_count,
      p.plan_code, p.name AS plan_name,
      b.subscription_status AS billing_status
    FROM public.workspaces w
    LEFT JOIN public.workspace_entitlements e ON e.workspace_id = w.id
    LEFT JOIN public.entitlement_profiles p ON p.id = e.entitlement_profile_id
    LEFT JOIN public.workspace_billing_accounts b ON b.workspace_id = w.id
    ORDER BY w.created_at ASC;
END
$$;

ALTER FUNCTION public.admin_list_workspace_directory() OWNER TO reachagent_function_owner;

-- ─────────────────────────────────────────────────────────────────────────────
-- Platform workspace actions (status, name)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION public.admin_set_workspace_status(
  p_workspace_id uuid,
  p_status text,
  p_actor_id uuid DEFAULT NULL,
  p_actor_role text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
  v_old_status text;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  PERFORM reachagent_private.assert_admin_actor(p_workspace_id, p_actor_id, p_actor_role, true);
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'workspace_id required'; END IF;
  IF p_status NOT IN ('active', 'suspended', 'archived') THEN
    RAISE EXCEPTION 'invalid workspace status' USING ERRCODE = '22023';
  END IF;
  IF p_workspace_id = '00000000-0000-0000-0000-000000000001'::uuid AND p_status <> 'active' THEN
    RAISE EXCEPTION 'the seed workspace must remain active' USING ERRCODE = 'P0001';
  END IF;

  SELECT status INTO v_old_status FROM public.workspaces WHERE id = p_workspace_id;
  IF v_old_status IS NULL THEN RAISE EXCEPTION 'unknown workspace' USING ERRCODE = '22023'; END IF;

  UPDATE public.workspaces SET status = p_status WHERE id = p_workspace_id;

  INSERT INTO public.audit_events (
    workspace_id, actor_user_id, actor_type, actor_role, action, target_type,
    target_id, result, source, metadata
  ) VALUES (
    p_workspace_id, p_actor_id, 'user', p_actor_role,
    'platform.workspace.status_changed', 'workspace', p_workspace_id::text,
    'success', 'application',
    pg_catalog.jsonb_build_object('old_status', v_old_status, 'new_status', p_status)
  );
END
$$;

ALTER FUNCTION public.admin_set_workspace_status(uuid, text, uuid, text) OWNER TO reachagent_function_owner;

CREATE FUNCTION public.admin_update_workspace_name(
  p_workspace_id uuid,
  p_name text,
  p_actor_id uuid DEFAULT NULL,
  p_actor_role text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
  v_old_name text;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  PERFORM reachagent_private.assert_admin_actor(p_workspace_id, p_actor_id, p_actor_role, true);
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'workspace_id required'; END IF;
  IF NULLIF(pg_catalog.btrim(p_name), '') IS NULL OR pg_catalog.length(pg_catalog.btrim(p_name)) > 120 THEN
    RAISE EXCEPTION 'invalid workspace name' USING ERRCODE = '22023';
  END IF;

  SELECT name INTO v_old_name FROM public.workspaces WHERE id = p_workspace_id;
  IF v_old_name IS NULL THEN RAISE EXCEPTION 'unknown workspace' USING ERRCODE = '22023'; END IF;

  UPDATE public.workspaces SET name = pg_catalog.btrim(p_name) WHERE id = p_workspace_id;

  INSERT INTO public.audit_events (
    workspace_id, actor_user_id, actor_type, actor_role, action, target_type,
    target_id, result, source, metadata
  ) VALUES (
    p_workspace_id, p_actor_id, 'user', p_actor_role,
    'workspace.updated', 'workspace', p_workspace_id::text,
    'success', 'application',
    pg_catalog.jsonb_build_object('old_name', v_old_name, 'new_name', pg_catalog.btrim(p_name))
  );
END
$$;

ALTER FUNCTION public.admin_update_workspace_name(uuid, text, uuid, text) OWNER TO reachagent_function_owner;

-- ─────────────────────────────────────────────────────────────────────────────
-- Membership administration (guarded, audited)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION public.admin_add_workspace_member(
  p_workspace_id uuid,
  p_target_user_id uuid,
  p_role text,
  p_actor_id uuid DEFAULT NULL,
  p_actor_role text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  PERFORM reachagent_private.assert_admin_actor(p_workspace_id, p_actor_id, p_actor_role);
  IF p_workspace_id IS NULL OR p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'workspace_id and target_user_id are required';
  END IF;
  IF p_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'invalid workspace role' USING ERRCODE = '22023';
  END IF;
  IF p_actor_role = 'admin' AND p_role = 'owner' THEN
    RAISE EXCEPTION 'workspace admins cannot grant owner' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_target_user_id) THEN
    RAISE EXCEPTION 'unknown profile' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = p_workspace_id) THEN
    RAISE EXCEPTION 'unknown workspace' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id
  ) THEN
    RAISE EXCEPTION 'membership already exists' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.workspace_members (workspace_id, user_id, role, status)
  VALUES (p_workspace_id, p_target_user_id, p_role, 'active');

  INSERT INTO public.audit_events (
    workspace_id, actor_user_id, actor_type, actor_role, action, target_type,
    target_id, result, source, metadata
  ) VALUES (
    p_workspace_id, p_actor_id, 'user', p_actor_role,
    'workspace.member.added', 'workspace_member', p_target_user_id::text,
    'success', 'application',
    pg_catalog.jsonb_build_object('role', p_role)
  );
END
$$;

ALTER FUNCTION public.admin_add_workspace_member(uuid, uuid, text, uuid, text) OWNER TO reachagent_function_owner;

CREATE FUNCTION public.admin_set_workspace_member_role(
  p_workspace_id uuid,
  p_target_user_id uuid,
  p_role text,
  p_actor_id uuid DEFAULT NULL,
  p_actor_role text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
  v_current text;
  v_current_status text;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  PERFORM reachagent_private.assert_admin_actor(p_workspace_id, p_actor_id, p_actor_role);
  IF p_workspace_id IS NULL OR p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'workspace_id and target_user_id are required';
  END IF;
  IF p_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'invalid workspace role' USING ERRCODE = '22023';
  END IF;

  SELECT role, status INTO v_current, v_current_status FROM public.workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;
  IF v_current IS NULL THEN RAISE EXCEPTION 'membership not found' USING ERRCODE = '22023'; END IF;
  IF p_actor_role = 'admin' AND (v_current = 'owner' OR p_role = 'owner') THEN
    RAISE EXCEPTION 'workspace admins cannot manage owners' USING ERRCODE = '42501';
  END IF;

  IF v_current = 'owner' AND v_current_status = 'active' AND p_role <> 'owner'
     AND reachagent_private.workspace_active_owner_count(p_workspace_id) <= 1 THEN
    RAISE EXCEPTION 'cannot demote the last active workspace owner' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.workspace_members
  SET role = p_role, updated_at = pg_catalog.now()
  WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;

  INSERT INTO public.audit_events (
    workspace_id, actor_user_id, actor_type, actor_role, action, target_type,
    target_id, result, source, metadata
  ) VALUES (
    p_workspace_id, p_actor_id, 'user', p_actor_role,
    'workspace.member.role_changed', 'workspace_member', p_target_user_id::text,
    'success', 'application',
    pg_catalog.jsonb_build_object('old_role', v_current, 'new_role', p_role)
  );
END
$$;

ALTER FUNCTION public.admin_set_workspace_member_role(uuid, uuid, text, uuid, text) OWNER TO reachagent_function_owner;

CREATE FUNCTION public.admin_set_workspace_member_status(
  p_workspace_id uuid,
  p_target_user_id uuid,
  p_status text,
  p_actor_id uuid DEFAULT NULL,
  p_actor_role text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
  v_current text;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  PERFORM reachagent_private.assert_admin_actor(p_workspace_id, p_actor_id, p_actor_role);
  IF p_workspace_id IS NULL OR p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'workspace_id and target_user_id are required';
  END IF;
  IF p_status NOT IN ('active', 'invited', 'suspended') THEN
    RAISE EXCEPTION 'invalid membership status' USING ERRCODE = '22023';
  END IF;

  SELECT status INTO v_current FROM public.workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;
  IF v_current IS NULL THEN RAISE EXCEPTION 'membership not found' USING ERRCODE = '22023'; END IF;
  IF p_actor_role = 'admin' AND EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'workspace admins cannot manage owners' USING ERRCODE = '42501';
  END IF;

  IF p_status <> 'active' AND EXISTS (
    SELECT 1 FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id
      AND role = 'owner' AND status = 'active'
  ) AND reachagent_private.workspace_active_owner_count(p_workspace_id) <= 1 THEN
    RAISE EXCEPTION 'cannot deactivate the last active workspace owner' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.workspace_members
  SET status = p_status, updated_at = pg_catalog.now()
  WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;

  INSERT INTO public.audit_events (
    workspace_id, actor_user_id, actor_type, actor_role, action, target_type,
    target_id, result, source, metadata
  ) VALUES (
    p_workspace_id, p_actor_id, 'user', p_actor_role,
    CASE WHEN p_status = 'active' THEN 'workspace.member.reactivated'
         ELSE 'workspace.member.deactivated' END,
    'workspace_member', p_target_user_id::text,
    'success', 'application',
    pg_catalog.jsonb_build_object('old_status', v_current, 'new_status', p_status)
  );
END
$$;

ALTER FUNCTION public.admin_set_workspace_member_status(uuid, uuid, text, uuid, text) OWNER TO reachagent_function_owner;

CREATE FUNCTION public.admin_remove_workspace_member(
  p_workspace_id uuid,
  p_target_user_id uuid,
  p_actor_id uuid DEFAULT NULL,
  p_actor_role text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
  v_old_role text;
  v_old_status text;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  PERFORM reachagent_private.assert_admin_actor(p_workspace_id, p_actor_id, p_actor_role);
  IF p_workspace_id IS NULL OR p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'workspace_id and target_user_id are required';
  END IF;

  SELECT role, status INTO v_old_role, v_old_status FROM public.workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;
  IF v_old_role IS NULL THEN RAISE EXCEPTION 'membership not found' USING ERRCODE = '22023'; END IF;
  IF p_actor_role = 'admin' AND v_old_role = 'owner' THEN
    RAISE EXCEPTION 'workspace admins cannot manage owners' USING ERRCODE = '42501';
  END IF;

  IF v_old_role = 'owner' AND v_old_status = 'active'
     AND reachagent_private.workspace_active_owner_count(p_workspace_id) <= 1 THEN
    RAISE EXCEPTION 'cannot remove the last active workspace owner' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.workspace_members
  WHERE workspace_id = p_workspace_id AND user_id = p_target_user_id;

  INSERT INTO public.audit_events (
    workspace_id, actor_user_id, actor_type, actor_role, action, target_type,
    target_id, result, source, metadata
  ) VALUES (
    p_workspace_id, p_actor_id, 'user', p_actor_role,
    'workspace.member.removed', 'workspace_member', p_target_user_id::text,
    'success', 'application',
    pg_catalog.jsonb_build_object('old_role', v_old_role, 'old_status', v_old_status)
  );
END
$$;

ALTER FUNCTION public.admin_remove_workspace_member(uuid, uuid, uuid, text) OWNER TO reachagent_function_owner;

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit read RPC (service_role; application enforces scope)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION public.admin_list_audit_events(
  p_workspace_id uuid DEFAULT NULL,
  p_action text DEFAULT NULL,
  p_actor_user_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_cursor_created_at timestamptz DEFAULT NULL,
  p_cursor_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
  v_limit integer;
  v_all jsonb := '[]'::jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_last timestamptz;
  v_last_id uuid;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  IF p_action IS NOT NULL AND p_action !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' THEN
    RAISE EXCEPTION 'invalid audit action filter' USING ERRCODE = '22023';
  END IF;
  IF (p_cursor_created_at IS NULL) <> (p_cursor_id IS NULL) THEN
    RAISE EXCEPTION 'audit cursor requires timestamp and id' USING ERRCODE = '22023';
  END IF;
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);

  SELECT COALESCE(pg_catalog.jsonb_agg(t.item ORDER BY t.created_at DESC, t.id DESC), '[]'::jsonb)
  INTO v_all
  FROM (
    SELECT
      pg_catalog.jsonb_build_object(
        'id', e.id,
        'workspace_id', e.workspace_id,
        'actor_user_id', e.actor_user_id,
        'actor_type', e.actor_type,
        'actor_role', e.actor_role,
        'action', e.action,
        'target_type', e.target_type,
        'target_id', e.target_id,
        'result', e.result,
        'request_id', e.request_id,
        'source', e.source,
        'metadata', e.metadata,
        'created_at', e.created_at
      ) AS item,
      e.created_at, e.id
    FROM public.audit_events e
    WHERE (p_workspace_id IS NULL OR e.workspace_id = p_workspace_id)
      AND (p_action IS NULL OR e.action = p_action)
      AND (p_actor_user_id IS NULL OR e.actor_user_id = p_actor_user_id)
      AND (
        p_cursor_created_at IS NULL
        OR e.created_at < p_cursor_created_at
        OR (e.created_at = p_cursor_created_at AND e.id < p_cursor_id)
      )
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT v_limit + 1
  ) t;

  IF jsonb_array_length(v_all) > v_limit THEN
    v_has_more := true;
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(x.elem ORDER BY x.ord), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT a.elem, a.ord
    FROM pg_catalog.jsonb_array_elements(v_all) WITH ORDINALITY AS a(elem, ord)
    WHERE a.ord <= v_limit
  ) x;

  IF v_has_more AND jsonb_array_length(v_rows) > 0 THEN
    v_last := (v_rows -> (jsonb_array_length(v_rows) - 1)) ->> 'created_at';
    v_last_id := ((v_rows -> (jsonb_array_length(v_rows) - 1)) ->> 'id')::uuid;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'events', v_rows,
    'has_more', v_has_more,
    'next_cursor',
    CASE WHEN v_has_more THEN
      pg_catalog.jsonb_build_object('created_at', v_last, 'id', v_last_id)
    ELSE NULL END
  );
END
$$;

ALTER FUNCTION public.admin_list_audit_events(uuid, text, uuid, integer, timestamptz, uuid) OWNER TO reachagent_function_owner;

-- ─────────────────────────────────────────────────────────────────────────────
-- SaaS 6 entitlement override audit mirror (transactional)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION reachagent_private.mirror_override_audit_to_events() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  INSERT INTO public.audit_events (
    workspace_id, actor_user_id, actor_type, actor_role, action, target_type,
    target_id, result, source, metadata
  ) VALUES (
    NEW.workspace_id, NEW.actor_id,
    CASE WHEN NEW.actor_id IS NULL THEN 'service_role' ELSE 'user' END,
    CASE WHEN NEW.actor_id IS NULL THEN NULL ELSE 'platform_admin' END,
    CASE WHEN NEW.action = 'set' THEN 'workspace.entitlement.override_set'
         ELSE 'workspace.entitlement.override_cleared' END,
    'workspace_entitlement_override', NEW.dimension_key,
    'success', 'database',
    pg_catalog.jsonb_build_object(
      'dimension', NEW.dimension_key,
      'limit_value', NEW.limit_value
    )
  );
  RETURN NEW;
END
$$;

ALTER FUNCTION reachagent_private.mirror_override_audit_to_events() OWNER TO reachagent_function_owner;

CREATE TRIGGER mirror_override_audit_to_audit_events
  AFTER INSERT ON public.workspace_entitlement_override_audit
  FOR EACH ROW EXECUTE FUNCTION reachagent_private.mirror_override_audit_to_events();

-- Prevent deletion, deactivation, or demotion of the final active platform
-- administrator. The advisory lock serializes concurrent admin changes.
CREATE FUNCTION reachagent_private.protect_final_platform_admin() RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_removes_admin boolean := false;
BEGIN
  IF OLD.role = 'admin' AND OLD.is_active = true THEN
    IF TG_OP = 'DELETE' THEN
      v_removes_admin := true;
    ELSE
      v_removes_admin := NEW.role <> 'admin' OR NEW.is_active <> true;
    END IF;
    IF v_removes_admin THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(82408001);
      IF (SELECT pg_catalog.count(*) FROM public.profiles WHERE role = 'admin' AND is_active = true) <= 1 THEN
        RAISE EXCEPTION 'cannot remove the final active platform admin' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION reachagent_private.protect_final_platform_admin() OWNER TO reachagent_function_owner;

CREATE TRIGGER protect_final_platform_admin
  BEFORE UPDATE OF role, is_active OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION reachagent_private.protect_final_platform_admin();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_events_platform_read ON public.audit_events
  FOR SELECT TO authenticated USING (public.is_platform_admin());

CREATE POLICY audit_events_workspace_admin_read ON public.audit_events
  FOR SELECT TO authenticated USING (
    workspace_id IS NOT NULL AND public.is_workspace_member(workspace_id, 'admin')
  );

-- No INSERT/UPDATE/DELETE policies: authenticated roles are append-only readers.
-- Only the restricted function owner may insert; service_role uses validated RPCs.

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON TABLE public.audit_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.audit_events TO authenticated;
GRANT SELECT ON TABLE public.audit_events TO service_role;
GRANT SELECT, INSERT ON TABLE public.audit_events TO reachagent_function_owner;

REVOKE ALL ON FUNCTION public.write_audit_event(
  uuid, uuid, text, text, text, text, text, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_audit_event(
  uuid, uuid, text, text, text, text, text, text, text, text, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.admin_list_workspace_directory() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_workspace_directory() TO service_role;

REVOKE ALL ON FUNCTION public.admin_list_audit_events(uuid, text, uuid, integer, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_audit_events(uuid, text, uuid, integer, timestamptz, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.admin_set_workspace_status(uuid, text, uuid, text),
  public.admin_update_workspace_name(uuid, text, uuid, text),
  public.admin_add_workspace_member(uuid, uuid, text, uuid, text),
  public.admin_set_workspace_member_role(uuid, uuid, text, uuid, text),
  public.admin_set_workspace_member_status(uuid, uuid, text, uuid, text),
  public.admin_remove_workspace_member(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_workspace_status(uuid, text, uuid, text),
  public.admin_update_workspace_name(uuid, text, uuid, text),
  public.admin_add_workspace_member(uuid, uuid, text, uuid, text),
  public.admin_set_workspace_member_role(uuid, uuid, text, uuid, text),
  public.admin_set_workspace_member_status(uuid, uuid, text, uuid, text),
  public.admin_remove_workspace_member(uuid, uuid, uuid, text)
  TO service_role;

REVOKE ALL ON FUNCTION reachagent_private.sanitize_audit_metadata(jsonb),
  reachagent_private.reject_audit_event_mutation(),
  reachagent_private.workspace_active_owner_count(uuid),
  reachagent_private.assert_admin_actor(uuid, uuid, text, boolean),
  reachagent_private.mirror_override_audit_to_events(),
  reachagent_private.protect_final_platform_admin() FROM PUBLIC;

REVOKE reachagent_function_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
