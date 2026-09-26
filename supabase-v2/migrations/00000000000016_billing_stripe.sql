-- ReachAgent SaaS 7: Stripe billing state and deterministic entitlement mapping.
-- Commercial prices and limits are deliberately not seeded here.

GRANT reachagent_function_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;

CREATE TABLE public.workspace_billing_accounts (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text UNIQUE,
  stripe_price_id text,
  plan_code text,
  subscription_status text NOT NULL DEFAULT 'none',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  trial_end timestamptz,
  sync_status text NOT NULL DEFAULT 'pending',
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_billing_plan_code_format CHECK (
    plan_code IS NULL OR plan_code ~ '^[a-z0-9][a-z0-9_]{0,79}$'
  ),
  CONSTRAINT workspace_billing_subscription_status CHECK (subscription_status IN (
    'none', 'active', 'trialing', 'past_due', 'unpaid', 'canceled',
    'incomplete', 'incomplete_expired', 'paused'
  )),
  CONSTRAINT workspace_billing_sync_status CHECK (sync_status IN ('pending', 'synced', 'error')),
  CONSTRAINT workspace_billing_error_bounded CHECK (
    last_sync_error IS NULL OR length(last_sync_error) <= 500
  )
);

ALTER TABLE public.workspace_billing_accounts OWNER TO postgres;
CREATE TRIGGER update_workspace_billing_accounts_updated_at
  BEFORE UPDATE ON public.workspace_billing_accounts FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX workspace_billing_status_idx
  ON public.workspace_billing_accounts (subscription_status, current_period_end);

CREATE TABLE public.stripe_webhook_events (
  stripe_event_id text PRIMARY KEY,
  event_type text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  processed_at timestamptz,
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stripe_webhook_event_id_bounded CHECK (length(stripe_event_id) BETWEEN 1 AND 255),
  CONSTRAINT stripe_webhook_event_type_bounded CHECK (length(event_type) BETWEEN 1 AND 120),
  CONSTRAINT stripe_webhook_event_status CHECK (status IN ('processing', 'processed', 'ignored', 'failed')),
  CONSTRAINT stripe_webhook_error_bounded CHECK (error_detail IS NULL OR length(error_detail) <= 500)
);

ALTER TABLE public.stripe_webhook_events OWNER TO postgres;
CREATE TRIGGER update_stripe_webhook_events_updated_at
  BEFORE UPDATE ON public.stripe_webhook_events FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX stripe_webhook_events_created_idx ON public.stripe_webhook_events (created_at DESC);

-- Safe fallback only. Commercial profiles/limits must be approved separately.
INSERT INTO public.entitlement_profiles (plan_code, name, description, is_internal)
VALUES ('billing_inactive', 'Billing inactive', 'Fail-closed entitlement for an ineligible subscription.', true)
ON CONFLICT (plan_code) DO NOTHING;

INSERT INTO public.entitlement_limits (entitlement_profile_id, dimension_key, limit_value)
SELECT p.id, d.dimension_key, 0
FROM public.entitlement_profiles p
CROSS JOIN (VALUES
  ('outbound_email'), ('ai_request'), ('discovery_request'),
  ('workspace_member'), ('mailbox_connection'), ('stored_lead')
) AS d(dimension_key)
WHERE p.plan_code = 'billing_inactive'
ON CONFLICT (entitlement_profile_id, dimension_key) DO UPDATE SET limit_value = EXCLUDED.limit_value;

-- Atomically persists normalized subscription state and assigns the SaaS 6
-- base entitlement. It never changes counters, events, or overrides.
CREATE FUNCTION public.sync_workspace_billing_entitlement(
  p_workspace_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_plan_code text,
  p_subscription_status text,
  p_current_period_start timestamptz DEFAULT NULL,
  p_current_period_end timestamptz DEFAULT NULL,
  p_cancel_at_period_end boolean DEFAULT false,
  p_trial_end timestamptz DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_role text := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
  v_current_plan text;
  v_target_plan text;
  v_profile_id uuid;
BEGIN
  IF v_role <> 'service_role' THEN RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501'; END IF;
  IF p_workspace_id IS NULL OR NULLIF(pg_catalog.btrim(p_stripe_customer_id), '') IS NULL THEN
    RAISE EXCEPTION 'workspace_id and stripe_customer_id are required' USING ERRCODE = '22023';
  END IF;
  IF p_subscription_status NOT IN (
    'none', 'active', 'trialing', 'past_due', 'unpaid', 'canceled',
    'incomplete', 'incomplete_expired', 'paused'
  ) THEN RAISE EXCEPTION 'unknown subscription status' USING ERRCODE = '22023'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.workspace_billing_accounts
    WHERE stripe_customer_id = p_stripe_customer_id AND workspace_id <> p_workspace_id
  ) THEN RAISE EXCEPTION 'stripe customer workspace mismatch' USING ERRCODE = '23505'; END IF;
  IF p_stripe_subscription_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.workspace_billing_accounts
    WHERE stripe_subscription_id = p_stripe_subscription_id AND workspace_id <> p_workspace_id
  ) THEN RAISE EXCEPTION 'stripe subscription workspace mismatch' USING ERRCODE = '23505'; END IF;

  SELECT ep.plan_code INTO v_current_plan
  FROM public.workspace_entitlements we
  JOIN public.entitlement_profiles ep ON ep.id = we.entitlement_profile_id
  WHERE we.workspace_id = p_workspace_id;

  IF p_workspace_id = '00000000-0000-0000-0000-000000000001'::uuid
     OR v_current_plan = 'internal_beta' THEN
    v_target_plan := 'internal_beta';
  ELSIF p_subscription_status IN ('active', 'trialing') THEN
    v_target_plan := p_plan_code;
    IF v_target_plan IS NULL THEN
      RAISE EXCEPTION 'active subscription requires mapped plan' USING ERRCODE = '22023';
    END IF;
  ELSE
    v_target_plan := 'billing_inactive';
  END IF;

  SELECT id INTO v_profile_id FROM public.entitlement_profiles
  WHERE plan_code = v_target_plan AND (v_target_plan IN ('billing_inactive', 'internal_beta') OR is_internal = false);
  IF v_profile_id IS NULL THEN RAISE EXCEPTION 'unknown entitlement profile' USING ERRCODE = '22023'; END IF;
  IF v_target_plan <> 'internal_beta' AND (
    SELECT pg_catalog.count(*) FROM public.entitlement_limits
    WHERE entitlement_profile_id = v_profile_id
  ) <> 6 THEN
    RAISE EXCEPTION 'entitlement profile limits are incomplete' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.workspace_billing_accounts (
    workspace_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
    plan_code, subscription_status, current_period_start, current_period_end,
    cancel_at_period_end, trial_end, sync_status, last_synced_at, last_sync_error
  ) VALUES (
    p_workspace_id, p_stripe_customer_id, p_stripe_subscription_id, p_stripe_price_id,
    p_plan_code, p_subscription_status, p_current_period_start, p_current_period_end,
    COALESCE(p_cancel_at_period_end, false), p_trial_end, 'synced', pg_catalog.now(), NULL
  ) ON CONFLICT (workspace_id) DO UPDATE SET
    stripe_customer_id = EXCLUDED.stripe_customer_id,
    stripe_subscription_id = EXCLUDED.stripe_subscription_id,
    stripe_price_id = EXCLUDED.stripe_price_id,
    plan_code = EXCLUDED.plan_code,
    subscription_status = EXCLUDED.subscription_status,
    current_period_start = EXCLUDED.current_period_start,
    current_period_end = EXCLUDED.current_period_end,
    cancel_at_period_end = EXCLUDED.cancel_at_period_end,
    trial_end = EXCLUDED.trial_end,
    sync_status = 'synced', last_synced_at = pg_catalog.now(), last_sync_error = NULL;

  INSERT INTO public.workspace_entitlements (workspace_id, entitlement_profile_id)
  VALUES (p_workspace_id, v_profile_id)
  ON CONFLICT (workspace_id) DO UPDATE SET
    entitlement_profile_id = EXCLUDED.entitlement_profile_id,
    assigned_by = NULL,
    updated_at = pg_catalog.now();

  RETURN v_target_plan;
END
$$;

ALTER FUNCTION public.sync_workspace_billing_entitlement(
  uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz
) OWNER TO reachagent_function_owner;

ALTER TABLE public.workspace_billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_billing_admin_read ON public.workspace_billing_accounts
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, 'admin') OR public.is_platform_admin());
CREATE POLICY stripe_webhook_events_platform_read ON public.stripe_webhook_events
  FOR SELECT TO authenticated USING (public.is_platform_admin());

REVOKE ALL ON TABLE public.workspace_billing_accounts, public.stripe_webhook_events
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.workspace_billing_accounts, public.stripe_webhook_events TO authenticated;
GRANT ALL ON TABLE public.workspace_billing_accounts, public.stripe_webhook_events TO service_role, reachagent_function_owner;

REVOKE ALL ON FUNCTION public.sync_workspace_billing_entitlement(
  uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_workspace_billing_entitlement(
  uuid, text, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz
) TO service_role;

REVOKE reachagent_function_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
