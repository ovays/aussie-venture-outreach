-- ReachAgent SaaS 6: workspace-level usage, entitlements & quotas.
--
-- Deterministic quota enforcement. AI must never decide whether quota is
-- exceeded; these tables + functions are the durable source of truth.
--
-- Design notes:
--   * `entitlement_profiles` / `entitlement_limits` are a generic plan catalog
--     (no pricing). SaaS 7 maps these to Stripe products/prices later.
--   * `workspace_entitlements` assigns a workspace to a profile.
--   * `workspace_entitlement_overrides` holds auditable, nullable, workspace
--     scoped platform-admin overrides, clearly separated from plan defaults.
--   * `workspace_usage_periods` / `workspace_usage_counters` hold durable
--     aggregate counters per UTC monthly period.
--   * `workspace_usage_events` is a minimal idempotency/audit ledger (one tiny
--     row per logical operation, never a duplicate of operational tables).
--   * A NULL limit means "unlimited". A workspace with no entitlement row is
--     treated as having no entitlement and consumption fails closed.
--
-- Dimensions (stable machine-readable keys):
--   outbound_email     — outbound emails sent per period (consumable)
--   ai_request         — real AI provider requests per period (consumable)
--   discovery_request  — Finder/external discovery calls per period (consumable)
--   workspace_member   — active workspace members (count)
--   mailbox_connection — connected mailboxes (count)
--   stored_lead        — stored leads (count; structural only, not enforced)

GRANT reachagent_function_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Entitlement catalog (no pricing)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.entitlement_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  is_internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlement_profiles_plan_code_format
    CHECK (plan_code ~ '^[a-z0-9][a-z0-9_]{0,79}$'),
  CONSTRAINT entitlement_profiles_name_bounded
    CHECK (length(btrim(name)) BETWEEN 1 AND 120)
);

ALTER TABLE public.entitlement_profiles OWNER TO postgres;

CREATE TRIGGER update_entitlement_profiles_updated_at
  BEFORE UPDATE ON public.entitlement_profiles FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.entitlement_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_profile_id uuid NOT NULL REFERENCES public.entitlement_profiles(id) ON DELETE CASCADE,
  dimension_key text NOT NULL,
  limit_value numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlement_limits_dimension_key_check CHECK (dimension_key IN (
    'outbound_email', 'ai_request', 'discovery_request',
    'workspace_member', 'mailbox_connection', 'stored_lead'
  )),
  CONSTRAINT entitlement_limits_limit_value_check CHECK (limit_value IS NULL OR limit_value >= 0),
  CONSTRAINT entitlement_limits_profile_dimension_unique
    UNIQUE (entitlement_profile_id, dimension_key)
);

ALTER TABLE public.entitlement_limits OWNER TO postgres;

CREATE TRIGGER update_entitlement_limits_updated_at
  BEFORE UPDATE ON public.entitlement_limits FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────────────
-- Workspace assignment + overrides
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.workspace_entitlements (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  entitlement_profile_id uuid NOT NULL REFERENCES public.entitlement_profiles(id) ON DELETE RESTRICT,
  assigned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.workspace_entitlements OWNER TO postgres;

CREATE TRIGGER update_workspace_entitlements_updated_at
  BEFORE UPDATE ON public.workspace_entitlements FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.workspace_entitlement_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  dimension_key text NOT NULL,
  limit_value numeric,
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_entitlement_overrides_dimension_key_check CHECK (dimension_key IN (
    'outbound_email', 'ai_request', 'discovery_request',
    'workspace_member', 'mailbox_connection', 'stored_lead'
  )),
  CONSTRAINT workspace_entitlement_overrides_limit_value_check CHECK (limit_value IS NULL OR limit_value >= 0),
  CONSTRAINT workspace_entitlement_overrides_workspace_dimension_unique
    UNIQUE (workspace_id, dimension_key)
);

ALTER TABLE public.workspace_entitlement_overrides OWNER TO postgres;

CREATE TRIGGER update_workspace_entitlement_overrides_updated_at
  BEFORE UPDATE ON public.workspace_entitlement_overrides FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.workspace_entitlement_override_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  dimension_key text NOT NULL,
  action text NOT NULL CHECK (action IN ('set', 'clear')),
  limit_value numeric,
  notes text,
  actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_entitlement_override_audit_dimension_check CHECK (dimension_key IN (
    'outbound_email', 'ai_request', 'discovery_request',
    'workspace_member', 'mailbox_connection', 'stored_lead'
  ))
);

ALTER TABLE public.workspace_entitlement_override_audit OWNER TO postgres;

CREATE INDEX workspace_entitlement_override_audit_workspace_created_idx
  ON public.workspace_entitlement_override_audit (workspace_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Usage periods + counters
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.workspace_usage_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  period_type text NOT NULL DEFAULT 'monthly' CHECK (period_type IN ('monthly')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_usage_periods_ordered CHECK (period_end > period_start),
  CONSTRAINT workspace_usage_periods_workspace_type_start_unique
    UNIQUE (workspace_id, period_type, period_start),
  CONSTRAINT workspace_usage_periods_workspace_id_unique
    UNIQUE (workspace_id, id)
);

ALTER TABLE public.workspace_usage_periods OWNER TO postgres;

CREATE INDEX workspace_usage_periods_workspace_start_idx
  ON public.workspace_usage_periods (workspace_id, period_start);

CREATE TABLE public.workspace_usage_counters (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  usage_period_id uuid NOT NULL,
  dimension_key text NOT NULL,
  used numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_usage_counters_dimension_key_check CHECK (dimension_key IN (
    'outbound_email', 'ai_request', 'discovery_request'
  )),
  CONSTRAINT workspace_usage_counters_used_check CHECK (used >= 0),
  CONSTRAINT workspace_usage_counters_period_workspace_fkey
    FOREIGN KEY (workspace_id, usage_period_id)
    REFERENCES public.workspace_usage_periods(workspace_id, id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, usage_period_id, dimension_key)
);

ALTER TABLE public.workspace_usage_counters OWNER TO postgres;

CREATE TABLE public.workspace_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  usage_period_id uuid NOT NULL,
  dimension_key text NOT NULL,
  idempotency_key text NOT NULL,
  amount numeric NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_usage_events_dimension_key_check CHECK (dimension_key IN (
    'outbound_email', 'ai_request', 'discovery_request'
  )),
  CONSTRAINT workspace_usage_events_amount_check CHECK (amount > 0),
  CONSTRAINT workspace_usage_events_idempotency_key_bounded CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT workspace_usage_events_period_workspace_fkey
    FOREIGN KEY (workspace_id, usage_period_id)
    REFERENCES public.workspace_usage_periods(workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE public.workspace_usage_events OWNER TO postgres;

-- One event per (workspace, period, dimension, idempotency key). A retry within
-- the same usage period dedupes; a genuinely new operation in a later period is
-- a fresh consumption.
CREATE UNIQUE INDEX workspace_usage_events_idempotency_key
  ON public.workspace_usage_events (workspace_id, usage_period_id, dimension_key, idempotency_key);

CREATE INDEX workspace_usage_events_period_idx
  ON public.workspace_usage_events (usage_period_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: internal/beta entitlement for migrated workspaces
-- ─────────────────────────────────────────────────────────────────────────────
-- NULL limit = unlimited. This is staging-only; public pricing is NOT inferred
-- from this configuration.

INSERT INTO public.entitlement_profiles (plan_code, name, description, is_internal)
VALUES (
  'internal_beta',
  'Internal Beta',
  'Staging entitlement for the migrated Aussie Venture workspace. Unlimited limits; not a commercial plan.',
  true
)
ON CONFLICT (plan_code) DO NOTHING;

INSERT INTO public.entitlement_limits (entitlement_profile_id, dimension_key, limit_value)
SELECT p.id, d.dimension_key, NULL
FROM public.entitlement_profiles p
CROSS JOIN (VALUES
  ('outbound_email'),
  ('ai_request'),
  ('discovery_request'),
  ('workspace_member'),
  ('mailbox_connection'),
  ('stored_lead')
) AS d(dimension_key)
WHERE p.plan_code = 'internal_beta'
ON CONFLICT (entitlement_profile_id, dimension_key) DO NOTHING;

-- Backfill every existing workspace with the internal beta profile. This is
-- additive and does not touch migrated operational data.
INSERT INTO public.workspace_entitlements (workspace_id, entitlement_profile_id)
SELECT w.id, p.id
FROM public.workspaces w
CROSS JOIN public.entitlement_profiles p
WHERE p.plan_code = 'internal_beta'
ON CONFLICT (workspace_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Internal helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- Current UTC monthly usage period, created on first use.
CREATE FUNCTION reachagent_private.ensure_usage_period(
  p_workspace_id uuid,
  p_period_type text DEFAULT 'monthly'
) RETURNS public.workspace_usage_periods
LANGUAGE plpgsql
SET timezone TO 'UTC'
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_start timestamptz := pg_catalog.date_trunc('month', pg_catalog.now());
  v_end timestamptz := pg_catalog.date_trunc('month', pg_catalog.now()) + interval '1 month';
  v_row public.workspace_usage_periods;
BEGIN
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'workspace_id required'; END IF;
  IF p_period_type <> 'monthly' THEN RAISE EXCEPTION 'unsupported period type'; END IF;

  INSERT INTO public.workspace_usage_periods (workspace_id, period_type, period_start, period_end)
  VALUES (p_workspace_id, p_period_type, v_start, v_end)
  ON CONFLICT (workspace_id, period_type, period_start) DO NOTHING;

  SELECT * INTO v_row
  FROM public.workspace_usage_periods
  WHERE workspace_id = p_workspace_id
    AND period_type = p_period_type
    AND period_start = v_start;
  RETURN v_row;
END
$$;

ALTER FUNCTION reachagent_private.ensure_usage_period(uuid, text) OWNER TO reachagent_function_owner;

-- Effective limit for a workspace + dimension. Override (when present) wins over
-- the profile default, including an explicit NULL (unlimited) override.
CREATE FUNCTION reachagent_private.effective_quota_limit(
  p_workspace_id uuid,
  p_dimension_key text
) RETURNS numeric
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT candidate.limit_value
  FROM (
    SELECT o.limit_value, 0 AS priority
    FROM public.workspace_entitlement_overrides o
    WHERE o.workspace_id = p_workspace_id AND o.dimension_key = p_dimension_key
    UNION ALL
    SELECT l.limit_value, 1 AS priority
    FROM public.workspace_entitlements e
    JOIN public.entitlement_limits l
      ON l.entitlement_profile_id = e.entitlement_profile_id
     AND l.dimension_key = p_dimension_key
    WHERE e.workspace_id = p_workspace_id
  ) AS candidate
  ORDER BY candidate.priority
  LIMIT 1
$$;

ALTER FUNCTION reachagent_private.effective_quota_limit(uuid, text) OWNER TO reachagent_function_owner;

-- ─────────────────────────────────────────────────────────────────────────────
-- Read-only quota check (service_role)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION public.check_workspace_quota(
  p_workspace_id uuid,
  p_dimension_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET timezone TO 'UTC'
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_limit numeric;
  v_used numeric := 0;
  v_allowed boolean;
  v_reason text := NULL;
  v_period public.workspace_usage_periods;
  v_period_start timestamptz := NULL;
  v_period_end timestamptz := NULL;
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'workspace_id required'; END IF;
  IF p_dimension_key NOT IN ('outbound_email','ai_request','discovery_request','workspace_member','mailbox_connection','stored_lead') THEN
    RAISE EXCEPTION 'unknown quota dimension' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_entitlements WHERE workspace_id = p_workspace_id) THEN
    RAISE EXCEPTION 'NO_ENTITLEMENT' USING ERRCODE = '23514';
  END IF;

  v_limit := reachagent_private.effective_quota_limit(p_workspace_id, p_dimension_key);

  IF p_dimension_key IN ('outbound_email','ai_request','discovery_request') THEN
    v_period := reachagent_private.ensure_usage_period(p_workspace_id, 'monthly');
    v_period_start := v_period.period_start;
    v_period_end := v_period.period_end;
    SELECT COALESCE(c.used, 0) INTO v_used
    FROM public.workspace_usage_counters c
    WHERE c.workspace_id = p_workspace_id
      AND c.usage_period_id = v_period.id
      AND c.dimension_key = p_dimension_key;
  ELSIF p_dimension_key = 'workspace_member' THEN
    SELECT pg_catalog.count(*) INTO v_used
    FROM public.workspace_members
    WHERE workspace_id = p_workspace_id AND status = 'active';
  ELSIF p_dimension_key = 'mailbox_connection' THEN
    SELECT pg_catalog.count(*) INTO v_used
    FROM public.mailbox_connections
    WHERE workspace_id = p_workspace_id AND status <> 'disconnected';
  ELSIF p_dimension_key = 'stored_lead' THEN
    SELECT pg_catalog.count(*) INTO v_used
    FROM public.leads
    WHERE workspace_id = p_workspace_id;
  END IF;

  v_allowed := v_limit IS NULL OR v_used < v_limit;
  v_reason := CASE WHEN v_allowed THEN NULL ELSE 'QUOTA_EXCEEDED' END;

  RETURN pg_catalog.jsonb_build_object(
    'allowed', v_allowed,
    'dimension', p_dimension_key,
    'limit', v_limit,
    'used', v_used,
    'remaining', CASE WHEN v_limit IS NULL THEN NULL ELSE GREATEST(v_limit - v_used, 0::numeric) END,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'reason', v_reason
  );
END
$$;

ALTER FUNCTION public.check_workspace_quota(uuid, text) OWNER TO reachagent_function_owner;

-- ─────────────────────────────────────────────────────────────────────────────
-- Atomic + idempotent consumption (service_role)
-- ─────────────────────────────────────────────────────────────────────────────
-- Concurrency-safety: the final UPDATE re-reads `used` under a row lock and
-- re-evaluates the limit guard, so two workers can never both pass and exceed
-- the limit. Idempotency: the unique (workspace_id, dimension_key,
-- idempotency_key) index makes the first insert win and every retry observe the
-- existing event without double-consuming.

CREATE FUNCTION public.consume_workspace_quota(
  p_workspace_id uuid,
  p_dimension_key text,
  p_idempotency_key text,
  p_amount numeric DEFAULT 1
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET timezone TO 'UTC'
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_period public.workspace_usage_periods;
  v_limit numeric;
  v_used numeric := 0;
  v_new_used numeric;
  v_event_id uuid;
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'workspace_id required'; END IF;
  IF p_dimension_key NOT IN ('outbound_email','ai_request','discovery_request') THEN
    RAISE EXCEPTION 'dimension is not consumable' USING ERRCODE = '22023';
  END IF;
  IF NULLIF(pg_catalog.btrim(p_idempotency_key), '') IS NULL OR pg_catalog.length(p_idempotency_key) > 200 THEN
    RAISE EXCEPTION 'idempotency_key is required (max 200 chars)';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_entitlements WHERE workspace_id = p_workspace_id) THEN
    RAISE EXCEPTION 'NO_ENTITLEMENT' USING ERRCODE = '23514';
  END IF;

  v_period := reachagent_private.ensure_usage_period(p_workspace_id, 'monthly');

  INSERT INTO public.workspace_usage_counters (workspace_id, usage_period_id, dimension_key, used)
  VALUES (p_workspace_id, v_period.id, p_dimension_key, 0)
  ON CONFLICT (workspace_id, usage_period_id, dimension_key) DO NOTHING;

  v_limit := reachagent_private.effective_quota_limit(p_workspace_id, p_dimension_key);

  INSERT INTO public.workspace_usage_events (workspace_id, usage_period_id, dimension_key, idempotency_key, amount)
  VALUES (p_workspace_id, v_period.id, p_dimension_key, p_idempotency_key, p_amount)
  ON CONFLICT (workspace_id, usage_period_id, dimension_key, idempotency_key) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    SELECT COALESCE(c.used, 0) INTO v_used
    FROM public.workspace_usage_counters c
    WHERE c.workspace_id = p_workspace_id
      AND c.usage_period_id = v_period.id
      AND c.dimension_key = p_dimension_key;
    RETURN pg_catalog.jsonb_build_object(
      'allowed', true,
      'consumed', false,
      'already_consumed', true,
      'dimension', p_dimension_key,
      'limit', v_limit,
      'used', v_used,
      'remaining', CASE WHEN v_limit IS NULL THEN NULL ELSE GREATEST(v_limit - v_used, 0::numeric) END,
      'period_start', v_period.period_start,
      'period_end', v_period.period_end,
      'reason', NULL
    );
  END IF;

  UPDATE public.workspace_usage_counters
  SET used = used + p_amount,
      updated_at = pg_catalog.now()
  WHERE workspace_id = p_workspace_id
    AND usage_period_id = v_period.id
    AND dimension_key = p_dimension_key
    AND (v_limit IS NULL OR used + p_amount <= v_limit)
  RETURNING used INTO v_new_used;

  IF v_new_used IS NULL THEN
    RAISE EXCEPTION 'QUOTA_EXCEEDED' USING ERRCODE = 'P0001', HINT = p_dimension_key;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'allowed', true,
    'consumed', true,
    'already_consumed', false,
    'dimension', p_dimension_key,
    'limit', v_limit,
    'used', v_new_used,
    'remaining', CASE WHEN v_limit IS NULL THEN NULL ELSE GREATEST(v_limit - v_new_used, 0::numeric) END,
    'period_start', v_period.period_start,
    'period_end', v_period.period_end,
    'reason', NULL
  );
END
$$;

ALTER FUNCTION public.consume_workspace_quota(uuid, text, text, numeric) OWNER TO reachagent_function_owner;

-- ─────────────────────────────────────────────────────────────────────────────
-- Count quotas: deterministic DB-level guards on members and mailboxes.
-- ─────────────────────────────────────────────────────────────────────────────
-- Only blocks NEW active members once the effective limit is reached; it never
-- deletes or alters existing memberships.

CREATE FUNCTION reachagent_private.enforce_workspace_member_quota() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_limit numeric;
  v_count bigint;
BEGIN
  IF NEW.status <> 'active'
     OR (TG_OP = 'UPDATE' AND OLD.workspace_id = NEW.workspace_id AND OLD.status = 'active') THEN
    RETURN NEW;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.workspace_id::text || ':workspace_member', 0)
  );
  IF NOT EXISTS (SELECT 1 FROM public.workspace_entitlements WHERE workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'NO_ENTITLEMENT' USING ERRCODE = '23514', HINT = 'workspace_member';
  END IF;
  v_limit := reachagent_private.effective_quota_limit(NEW.workspace_id, 'workspace_member');
  IF v_limit IS NULL THEN RETURN NEW; END IF;
  SELECT pg_catalog.count(*) INTO v_count
  FROM public.workspace_members
  WHERE workspace_id = NEW.workspace_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'QUOTA_EXCEEDED: workspace member limit reached'
      USING ERRCODE = 'P0001', HINT = 'workspace_member';
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION reachagent_private.enforce_workspace_member_quota() OWNER TO reachagent_function_owner;

CREATE TRIGGER workspace_members_quota_check
  BEFORE INSERT OR UPDATE OF workspace_id, status ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION reachagent_private.enforce_workspace_member_quota();

CREATE FUNCTION reachagent_private.enforce_mailbox_connection_quota() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_limit numeric;
  v_count bigint;
BEGIN
  IF NEW.status = 'disconnected'
     OR (TG_OP = 'UPDATE' AND OLD.workspace_id = NEW.workspace_id AND OLD.status <> 'disconnected') THEN
    RETURN NEW;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.workspace_id::text || ':mailbox_connection', 0)
  );
  IF NOT EXISTS (SELECT 1 FROM public.workspace_entitlements WHERE workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'NO_ENTITLEMENT' USING ERRCODE = '23514', HINT = 'mailbox_connection';
  END IF;
  v_limit := reachagent_private.effective_quota_limit(NEW.workspace_id, 'mailbox_connection');
  IF v_limit IS NULL THEN RETURN NEW; END IF;
  SELECT pg_catalog.count(*) INTO v_count
  FROM public.mailbox_connections
  WHERE workspace_id = NEW.workspace_id AND status <> 'disconnected';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'QUOTA_EXCEEDED: mailbox connection limit reached'
      USING ERRCODE = 'P0001', HINT = 'mailbox_connection';
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION reachagent_private.enforce_mailbox_connection_quota() OWNER TO reachagent_function_owner;

CREATE TRIGGER mailbox_connections_quota_check
  BEFORE INSERT OR UPDATE OF workspace_id, status ON public.mailbox_connections
  FOR EACH ROW EXECUTE FUNCTION reachagent_private.enforce_mailbox_connection_quota();

-- ─────────────────────────────────────────────────────────────────────────────
-- Admin: assign entitlement profile / manage overrides (service_role)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION public.admin_set_workspace_entitlement(
  p_workspace_id uuid,
  p_plan_code text,
  p_actor_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_profile_id uuid;
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  IF p_workspace_id IS NULL OR NULLIF(pg_catalog.btrim(p_plan_code), '') IS NULL THEN
    RAISE EXCEPTION 'workspace_id and plan_code are required';
  END IF;
  SELECT id INTO v_profile_id FROM public.entitlement_profiles WHERE plan_code = p_plan_code;
  IF v_profile_id IS NULL THEN RAISE EXCEPTION 'unknown plan_code' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.workspace_entitlements (workspace_id, entitlement_profile_id)
  VALUES (p_workspace_id, v_profile_id)
  ON CONFLICT (workspace_id) DO UPDATE SET
    entitlement_profile_id = EXCLUDED.entitlement_profile_id,
    assigned_by = p_actor_id,
    updated_at = pg_catalog.now();
  UPDATE public.workspace_entitlements
  SET assigned_by = p_actor_id
  WHERE workspace_id = p_workspace_id;
END
$$;

ALTER FUNCTION public.admin_set_workspace_entitlement(uuid, text, uuid) OWNER TO reachagent_function_owner;

CREATE FUNCTION public.admin_set_workspace_override(
  p_workspace_id uuid,
  p_dimension_key text,
  p_limit_value numeric,
  p_notes text DEFAULT NULL,
  p_actor_id uuid DEFAULT NULL
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
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'workspace_id required'; END IF;
  IF p_dimension_key NOT IN ('outbound_email','ai_request','discovery_request','workspace_member','mailbox_connection','stored_lead') THEN
    RAISE EXCEPTION 'unknown quota dimension' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.workspace_entitlement_overrides (workspace_id, dimension_key, limit_value, notes, created_by, updated_by)
  VALUES (p_workspace_id, p_dimension_key, p_limit_value, NULLIF(pg_catalog.btrim(p_notes), ''), p_actor_id, p_actor_id)
  ON CONFLICT (workspace_id, dimension_key) DO UPDATE SET
    limit_value = EXCLUDED.limit_value,
    notes = EXCLUDED.notes,
    updated_by = p_actor_id,
    updated_at = pg_catalog.now();
  INSERT INTO public.workspace_entitlement_override_audit (
    workspace_id, dimension_key, action, limit_value, notes, actor_id
  ) VALUES (
    p_workspace_id, p_dimension_key, 'set', p_limit_value, NULLIF(pg_catalog.btrim(p_notes), ''), p_actor_id
  );
END
$$;

ALTER FUNCTION public.admin_set_workspace_override(uuid, text, numeric, text, uuid) OWNER TO reachagent_function_owner;

CREATE FUNCTION public.admin_clear_workspace_override(
  p_workspace_id uuid,
  p_dimension_key text,
  p_actor_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_limit_value numeric;
  v_notes text;
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  IF p_workspace_id IS NULL OR NULLIF(pg_catalog.btrim(p_dimension_key), '') IS NULL THEN
    RAISE EXCEPTION 'workspace_id and dimension_key are required';
  END IF;
  DELETE FROM public.workspace_entitlement_overrides
  WHERE workspace_id = p_workspace_id AND dimension_key = p_dimension_key
  RETURNING limit_value, notes INTO v_limit_value, v_notes;
  IF FOUND THEN
    INSERT INTO public.workspace_entitlement_override_audit (
      workspace_id, dimension_key, action, limit_value, notes, actor_id
    ) VALUES (p_workspace_id, p_dimension_key, 'clear', v_limit_value, v_notes, p_actor_id);
  END IF;
END
$$;

ALTER FUNCTION public.admin_clear_workspace_override(uuid, text, uuid) OWNER TO reachagent_function_owner;

-- Workspace usage overview: plan + effective limits + usage for every dimension.
-- Used by both the member-facing /api/usage endpoint and platform-admin
-- inspection. Overrides are intentionally omitted here (admin-only surface).
CREATE FUNCTION public.get_workspace_usage_overview(p_workspace_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET timezone TO 'UTC'
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
  v_period public.workspace_usage_periods;
  v_plan_code text;
  v_plan_name text;
  v_dims jsonb := '{}'::jsonb;
  d text;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'workspace_id required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_entitlements WHERE workspace_id = p_workspace_id) THEN
    RAISE EXCEPTION 'NO_ENTITLEMENT' USING ERRCODE = '23514';
  END IF;

  SELECT p.plan_code, p.name INTO v_plan_code, v_plan_name
  FROM public.workspace_entitlements e
  JOIN public.entitlement_profiles p ON p.id = e.entitlement_profile_id
  WHERE e.workspace_id = p_workspace_id;

  v_period := reachagent_private.ensure_usage_period(p_workspace_id, 'monthly');

  FOR d IN SELECT pg_catalog.unnest(ARRAY[
    'outbound_email','ai_request','discovery_request',
    'workspace_member','mailbox_connection','stored_lead'
  ])
  LOOP
    v_dims := v_dims || pg_catalog.jsonb_build_object(d, public.check_workspace_quota(p_workspace_id, d));
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'plan_code', v_plan_code,
    'plan_name', v_plan_name,
    'period_start', v_period.period_start,
    'period_end', v_period.period_end,
    'dimensions', v_dims
  );
END
$$;

ALTER FUNCTION public.get_workspace_usage_overview(uuid) OWNER TO reachagent_function_owner;

-- Platform-admin: list all workspaces with their effective entitlement.
CREATE FUNCTION public.admin_list_workspaces() RETURNS TABLE (
  id uuid,
  name text,
  slug text,
  status text,
  plan text,
  plan_code text,
  plan_name text,
  created_at timestamptz
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
    SELECT w.id, w.name, w.slug, w.status, w.plan,
           p.plan_code, p.name, w.created_at
    FROM public.workspaces w
    LEFT JOIN public.workspace_entitlements e ON e.workspace_id = w.id
    LEFT JOIN public.entitlement_profiles p ON p.id = e.entitlement_profile_id
    ORDER BY w.created_at ASC;
END
$$;

ALTER FUNCTION public.admin_list_workspaces() OWNER TO reachagent_function_owner;

-- Platform-admin: current overrides for a workspace.
CREATE FUNCTION public.admin_get_workspace_overrides(p_workspace_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
  v_result jsonb;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'workspace_id required'; END IF;
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'dimension_key', o.dimension_key,
        'limit_value', o.limit_value,
        'notes', o.notes,
        'updated_by', o.updated_by,
        'updated_at', o.updated_at
      ) ORDER BY o.dimension_key
    ), '[]'::jsonb
  ) INTO v_result
  FROM public.workspace_entitlement_overrides o
  WHERE o.workspace_id = p_workspace_id;
  RETURN v_result;
END
$$;

ALTER FUNCTION public.admin_get_workspace_overrides(uuid) OWNER TO reachagent_function_owner;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.entitlement_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entitlement_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_entitlement_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_entitlement_override_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_usage_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_usage_events ENABLE ROW LEVEL SECURITY;

-- Generic catalog: readable by any authenticated user; never writable by them.
CREATE POLICY entitlement_profiles_read ON public.entitlement_profiles
  FOR SELECT TO authenticated USING (true);
CREATE POLICY entitlement_limits_read ON public.entitlement_limits
  FOR SELECT TO authenticated USING (true);

-- Workspace-scoped: members read their own workspace usage.
CREATE POLICY workspace_entitlements_member_read ON public.workspace_entitlements
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id) OR public.is_platform_admin());

CREATE POLICY workspace_entitlement_overrides_admin_read ON public.workspace_entitlement_overrides
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, 'admin') OR public.is_platform_admin());

CREATE POLICY workspace_entitlement_override_audit_platform_read ON public.workspace_entitlement_override_audit
  FOR SELECT TO authenticated USING (public.is_platform_admin());

CREATE POLICY workspace_usage_periods_member_read ON public.workspace_usage_periods
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id) OR public.is_platform_admin());

CREATE POLICY workspace_usage_counters_member_read ON public.workspace_usage_counters
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id) OR public.is_platform_admin());

CREATE POLICY workspace_usage_events_admin_read ON public.workspace_usage_events
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, 'admin') OR public.is_platform_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON TABLE public.entitlement_profiles, public.entitlement_limits,
  public.workspace_entitlements, public.workspace_entitlement_overrides,
  public.workspace_entitlement_override_audit,
  public.workspace_usage_periods, public.workspace_usage_counters,
  public.workspace_usage_events FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.entitlement_profiles, public.entitlement_limits,
  public.workspace_entitlements, public.workspace_entitlement_overrides,
  public.workspace_entitlement_override_audit,
  public.workspace_usage_periods, public.workspace_usage_counters,
  public.workspace_usage_events TO authenticated;

GRANT ALL ON TABLE public.entitlement_profiles, public.entitlement_limits,
  public.workspace_entitlements, public.workspace_entitlement_overrides,
  public.workspace_entitlement_override_audit,
  public.workspace_usage_periods, public.workspace_usage_counters,
  public.workspace_usage_events TO service_role;

GRANT ALL ON TABLE public.entitlement_profiles, public.entitlement_limits,
  public.workspace_entitlements, public.workspace_entitlement_overrides,
  public.workspace_entitlement_override_audit,
  public.workspace_usage_periods, public.workspace_usage_counters,
  public.workspace_usage_events TO reachagent_function_owner;

-- Count-quota functions run as the restricted function owner and require only
-- read access to the pre-existing tenant tables they count.
GRANT SELECT ON TABLE public.mailbox_connections TO reachagent_function_owner;

-- Quota RPCs are service-role only: a browser client can never consume or
-- mutate quota directly; it reads usage via the application API route, which
-- resolves workspace membership server-side.
REVOKE ALL ON FUNCTION public.check_workspace_quota(uuid, text),
  public.consume_workspace_quota(uuid, text, text, numeric),
  public.get_workspace_usage_overview(uuid),
  public.admin_list_workspaces(),
  public.admin_get_workspace_overrides(uuid),
  public.admin_set_workspace_entitlement(uuid, text, uuid),
  public.admin_set_workspace_override(uuid, text, numeric, text, uuid),
  public.admin_clear_workspace_override(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_workspace_quota(uuid, text),
  public.consume_workspace_quota(uuid, text, text, numeric),
  public.get_workspace_usage_overview(uuid),
  public.admin_list_workspaces(),
  public.admin_get_workspace_overrides(uuid),
  public.admin_set_workspace_entitlement(uuid, text, uuid),
  public.admin_set_workspace_override(uuid, text, numeric, text, uuid),
  public.admin_clear_workspace_override(uuid, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION reachagent_private.ensure_usage_period(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reachagent_private.effective_quota_limit(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reachagent_private.enforce_workspace_member_quota() FROM PUBLIC;
REVOKE ALL ON FUNCTION reachagent_private.enforce_mailbox_connection_quota() FROM PUBLIC;

REVOKE reachagent_function_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
