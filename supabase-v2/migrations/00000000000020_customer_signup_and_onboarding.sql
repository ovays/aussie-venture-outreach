-- ReachAgent Prompt 3: public customer provisioning and pending team invitations.
-- Provisioning is an authenticated, atomic, retry-safe database operation.

INSERT INTO public.entitlement_profiles (plan_code, name, description, is_internal)
VALUES ('external_beta', 'External beta', 'Limited, paused customer beta access', false)
ON CONFLICT (plan_code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  is_internal = false;

INSERT INTO public.entitlement_limits (entitlement_profile_id, dimension_key, limit_value)
SELECT p.id, limits.dimension_key, limits.limit_value
FROM public.entitlement_profiles p
CROSS JOIN (VALUES
  ('outbound_email', 100::numeric),
  ('ai_request', 100::numeric),
  ('discovery_request', 100::numeric),
  ('workspace_member', 5::numeric),
  ('mailbox_connection', 2::numeric),
  ('stored_lead', 500::numeric)
) AS limits(dimension_key, limit_value)
WHERE p.plan_code = 'external_beta'
ON CONFLICT (entitlement_profile_id, dimension_key) DO UPDATE
SET limit_value = EXCLUDED.limit_value;

CREATE TABLE public.workspace_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'cancelled')),
  invited_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_invitations_email_format CHECK (email = lower(btrim(email)) AND position('@' IN email) > 1),
  CONSTRAINT workspace_invitations_pending_unique UNIQUE NULLS NOT DISTINCT (workspace_id, email, status)
);

ALTER TABLE public.workspace_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_invitations_admin_manage ON public.workspace_invitations
  FOR ALL TO authenticated
  USING (public.is_workspace_member(workspace_id, 'admin') OR public.is_platform_admin())
  WITH CHECK (public.is_workspace_member(workspace_id, 'admin') OR public.is_platform_admin());
REVOKE ALL ON public.workspace_invitations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_invitations TO authenticated;
GRANT ALL ON public.workspace_invitations TO service_role;

CREATE FUNCTION public.provision_customer_workspace()
RETURNS TABLE(workspace_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_name text;
  v_slug text;
  v_entitlement_id uuid;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text, 0));

  SELECT wm.workspace_id INTO v_workspace_id
  FROM public.workspace_members wm
  WHERE wm.user_id = v_user_id AND wm.status = 'active'
  ORDER BY wm.created_at LIMIT 1;
  IF v_workspace_id IS NOT NULL THEN RETURN QUERY SELECT v_workspace_id, false; RETURN; END IF;

  SELECT NULLIF(btrim(COALESCE(u.raw_user_meta_data ->> 'workspace_name', '')), '')
  INTO v_name FROM auth.users u WHERE u.id = v_user_id;
  IF v_name IS NULL OR length(v_name) > 120 THEN RAISE EXCEPTION 'A valid workspace name is required'; END IF;
  SELECT id INTO v_entitlement_id FROM public.entitlement_profiles WHERE plan_code = 'external_beta' AND is_internal = false;
  IF v_entitlement_id IS NULL THEN RAISE EXCEPTION 'External beta entitlement is unavailable'; END IF;

  v_workspace_id := gen_random_uuid();
  v_slug := left(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), 60);
  v_slug := trim(both '-' from v_slug);
  IF length(v_slug) < 2 THEN v_slug := 'workspace'; END IF;
  v_slug := v_slug || '-' || left(replace(v_workspace_id::text, '-', ''), 10);

  INSERT INTO public.workspaces (id, name, slug, status, plan)
  VALUES (v_workspace_id, v_name, v_slug, 'active', 'external_beta');
  INSERT INTO public.workspace_entitlements (workspace_id, entitlement_profile_id, assigned_by)
  VALUES (v_workspace_id, v_entitlement_id, v_user_id);
  INSERT INTO public.workspace_members (workspace_id, user_id, role, status)
  VALUES (v_workspace_id, v_user_id, 'owner', 'active');
  INSERT INTO public.workspace_settings (workspace_id, key, value, description) VALUES
    (v_workspace_id, 'onboarding_status', 'not_started', 'ReachAgent customer onboarding'),
    (v_workspace_id, 'onboarding_current_step', '1', 'ReachAgent customer onboarding'),
    (v_workspace_id, 'initial_email_mode', 'template', 'Customer preference; execution remains paused'),
    (v_workspace_id, 'automatic_followups_enabled', 'false', 'Customer preference; execution remains paused'),
    (v_workspace_id, 'follow_up_1_days', '7', 'Customer onboarding default'),
    (v_workspace_id, 'follow_up_2_days', '14', 'Customer onboarding default'),
    (v_workspace_id, 'follow_up_3_days', '21', 'Customer onboarding default'),
    (v_workspace_id, 'reactivation_delay_days', '90', 'Customer onboarding default'),
    (v_workspace_id, 'reactivation_enabled', 'false', 'Execution remains paused'),
    (v_workspace_id, 'system_active', 'false', 'Execution remains paused'),
    (v_workspace_id, 'mailbox_skipped', 'false', 'ReachAgent customer onboarding'),
    (v_workspace_id, 'active_cities', '', 'ReachAgent customer onboarding');
  RETURN QUERY SELECT v_workspace_id, true;
END $$;

REVOKE ALL ON FUNCTION public.provision_customer_workspace() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.provision_customer_workspace() TO authenticated;
GRANT EXECUTE ON FUNCTION public.provision_customer_workspace() TO service_role;
