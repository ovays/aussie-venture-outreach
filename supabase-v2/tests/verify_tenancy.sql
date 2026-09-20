\set ON_ERROR_STOP on

-- ReachAgent SaaS 1A tenancy verification. Exercises workspace-scoped RLS,
-- authoritative membership helpers, and cross-tenant fail-closed behavior.

CREATE OR REPLACE FUNCTION pg_temp.set_auth(p_sub uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.role', 'authenticated', true),
         set_config('request.jwt.claim.sub', p_sub::text, true);
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_true(condition boolean, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERTION FAILED: %', message; END IF;
END
$$;

-- Fixtures.
INSERT INTO public.workspaces (id, name, slug) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Second Tenant', 'second-tenant');

INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES
  ('10000000-0000-0000-0000-000000000001', 'member-a@example.test', 'Member A', 'member', true),
  ('10000000-0000-0000-0000-000000000002', 'admin@example.test', 'Admin', 'admin', true),
  ('10000000-0000-0000-0000-000000000003', 'member-b@example.test', 'Member B', 'member', true),
  ('10000000-0000-0000-0000-000000000004', 'outsider@example.test', 'Outsider', 'member', true);

INSERT INTO public.workspace_members (workspace_id, user_id, role, status) VALUES
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'member', 'active'),
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'owner', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003', 'member', 'active');

-- Helper assertions.
DO $$
BEGIN
  PERFORM pg_temp.set_auth('10000000-0000-0000-0000-000000000001');
  IF NOT public.is_workspace_member('00000000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'member-a should be a seed workspace member';
  END IF;
  IF public.is_workspace_member('aaaaaaaa-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'member-a should not be a second-workspace member';
  END IF;
  IF public.is_platform_admin() THEN
    RAISE EXCEPTION 'member-a should not be a platform admin';
  END IF;
END
$$;

DO $$
BEGIN
  PERFORM pg_temp.set_auth('10000000-0000-0000-0000-000000000002');
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'admin should be a platform admin';
  END IF;
  IF NOT public.is_workspace_member('00000000-0000-0000-0000-000000000001', 'owner') THEN
    RAISE EXCEPTION 'admin should be the seed workspace owner';
  END IF;
END
$$;

-- Seed workspace lead owned by member-a.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT pg_temp.set_auth('10000000-0000-0000-0000-000000000001');
INSERT INTO public.leads (workspace_id, business_name, category_name, city, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Seed Lead', 'Synthetic', 'Sydney', 'new');
COMMIT;

-- Member-a can read own-workspace lead; member-b cannot.
DO $$
BEGIN
  PERFORM pg_temp.set_auth('10000000-0000-0000-0000-000000000001');
  SET LOCAL ROLE authenticated;
  IF NOT EXISTS (SELECT 1 FROM public.leads WHERE business_name = 'Seed Lead') THEN
    RAISE EXCEPTION 'member-a cannot read seed lead';
  END IF;
END
$$;

DO $$
BEGIN
  PERFORM pg_temp.set_auth('10000000-0000-0000-0000-000000000003');
  SET LOCAL ROLE authenticated;
  IF EXISTS (SELECT 1 FROM public.leads WHERE business_name = 'Seed Lead') THEN
    RAISE EXCEPTION 'member-b can read a cross-tenant lead';
  END IF;
END
$$;

-- Outsider (no membership anywhere) cannot read any lead.
DO $$
BEGIN
  PERFORM pg_temp.set_auth('10000000-0000-0000-0000-000000000004');
  SET LOCAL ROLE authenticated;
  IF EXISTS (SELECT 1 FROM public.leads) THEN
    RAISE EXCEPTION 'outsider can read leads';
  END IF;
END
$$;

-- Platform admin can read across workspaces.
DO $$
BEGIN
  PERFORM pg_temp.set_auth('10000000-0000-0000-0000-000000000002');
  SET LOCAL ROLE authenticated;
  IF NOT EXISTS (SELECT 1 FROM public.leads WHERE business_name = 'Seed Lead') THEN
    RAISE EXCEPTION 'platform admin cannot read seed lead';
  END IF;
END
$$;

-- Cross-tenant write fails closed (target row remains untouched).
DO $$
DECLARE v_status text;
BEGIN
  PERFORM pg_temp.set_auth('10000000-0000-0000-0000-000000000003');
  SET LOCAL ROLE authenticated;
  UPDATE public.leads SET status = 'dead' WHERE business_name = 'Seed Lead';
  RESET ROLE;
  SELECT status INTO v_status FROM public.leads WHERE business_name = 'Seed Lead';
  IF v_status = 'dead' THEN
    RAISE EXCEPTION 'member-b updated a cross-tenant lead';
  END IF;
END
$$;

-- Insert without workspace_id uses the seed default (transitional behavior).
DO $$
DECLARE v_ws uuid;
BEGIN
  PERFORM pg_temp.set_auth('10000000-0000-0000-0000-000000000001');
  SET LOCAL ROLE authenticated;
  INSERT INTO public.leads (business_name, category_name, city, status)
  VALUES ('Default Workspace Lead', 'Synthetic', 'Sydney', 'new')
  RETURNING workspace_id INTO v_ws;
  RESET ROLE;
  IF v_ws IS DISTINCT FROM '00000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'insert without workspace_id did not default to seed workspace';
  END IF;
END
$$;

-- Invalid workspace_id is rejected by FK (owner role bypasses RLS).
DO $$
BEGIN
  BEGIN
    INSERT INTO public.leads (workspace_id, business_name, category_name, city, status)
    VALUES ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'Bad FK Lead', 'Synthetic', 'Sydney', 'new');
    RAISE EXCEPTION 'invalid workspace_id unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END
$$;

-- Service role bypasses RLS and must still satisfy NOT NULL.
BEGIN;
SET LOCAL ROLE service_role;
INSERT INTO public.leads (workspace_id, business_name, category_name, city, status)
VALUES ('aaaaaaaa-0000-0000-0000-000000000002', 'Second Workspace Lead', 'Synthetic', 'Sydney', 'new');
COMMIT;

SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM public.leads WHERE workspace_id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  'service_role can write to a non-seed workspace'
);

-- Workspace settings member read allowlist and cross-tenant isolation.
INSERT INTO public.workspace_settings (workspace_id, key, value) VALUES
  ('00000000-0000-0000-0000-000000000001', 'follow_up_1_days', '7'),
  ('00000000-0000-0000-0000-000000000001', 'digest_email', 'hello@example.test'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'follow_up_1_days', '9');

DO $$
BEGIN
  PERFORM pg_temp.set_auth('10000000-0000-0000-0000-000000000001');
  SET LOCAL ROLE authenticated;
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_settings
    WHERE workspace_id = '00000000-0000-0000-0000-000000000001' AND key = 'follow_up_1_days'
  ) THEN
    RAISE EXCEPTION 'member-a cannot read an allowlisted workspace setting';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.workspace_settings
    WHERE workspace_id = 'aaaaaaaa-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'member-a read another workspace settings row';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.workspace_settings
    WHERE workspace_id = '00000000-0000-0000-0000-000000000001' AND key = 'digest_email'
  ) THEN
    RAISE EXCEPTION 'member-a read a non-allowlisted workspace setting';
  END IF;
END
$$;

SELECT 'VERIFY_TENANCY_PASS' AS result;
