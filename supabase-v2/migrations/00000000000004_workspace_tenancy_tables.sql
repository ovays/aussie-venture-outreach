-- ReachAgent SaaS 1A: shared-schema tenancy foundation.
--
-- Adds the platform/workspace boundary tables and the authoritative
-- membership/role helpers. Tenant tables are wired to workspace_id in the next
-- migration; this file only creates the tenancy primitives and the seed
-- workspace that existing single-tenant data is backfilled into.

-- ReachAgent-owned SECURITY DEFINER helpers need the same temporary inheritable
-- membership used by the golden baseline and performance delta.
GRANT reachagent_function_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;

--
-- workspaces: tenant record
--

CREATE TABLE public.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  plan text NOT NULL DEFAULT 'seed',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_slug_key UNIQUE (slug),
  CONSTRAINT workspaces_name_bounded CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT workspaces_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,79}$')
);

ALTER TABLE public.workspaces OWNER TO postgres;

CREATE TRIGGER update_workspaces_updated_at
  BEFORE UPDATE ON public.workspaces FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

--
-- workspace_members: user <-> workspace role join
--

CREATE TABLE public.workspace_members (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

ALTER TABLE public.workspace_members OWNER TO postgres;

CREATE TRIGGER update_workspace_members_updated_at
  BEFORE UPDATE ON public.workspace_members FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX workspace_members_user_idx
  ON public.workspace_members (user_id) WHERE status = 'active';

--
-- workspace_settings: per-tenant key/value configuration
--

CREATE TABLE public.workspace_settings (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  value text NOT NULL,
  description text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

ALTER TABLE public.workspace_settings OWNER TO postgres;

CREATE TRIGGER update_workspace_settings_updated_at
  BEFORE UPDATE ON public.workspace_settings FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

--
-- Seed workspace: existing single-tenant data is backfilled into this record.
--

INSERT INTO public.workspaces (id, name, slug, status, plan)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Aussie Venture',
  'aussie-venture',
  'active',
  'seed'
);

--
-- reachagent_private.is_workspace_member(uuid, text)
--

CREATE FUNCTION reachagent_private.is_workspace_member(p_workspace_id uuid, p_min_role text DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_members AS m
    WHERE m.workspace_id = p_workspace_id
      AND m.user_id = COALESCE(
        NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
        (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      )::uuid
      AND m.status = 'active'
      AND CASE
        WHEN p_min_role IS NULL THEN TRUE
        WHEN p_min_role = 'member' THEN m.role IN ('member', 'admin', 'owner')
        WHEN p_min_role = 'admin' THEN m.role IN ('admin', 'owner')
        WHEN p_min_role = 'owner' THEN m.role = 'owner'
        ELSE FALSE
      END
  )
$$;

ALTER FUNCTION reachagent_private.is_workspace_member(uuid, text) OWNER TO reachagent_function_owner;

--
-- public.is_workspace_member(uuid, text): SECURITY DEFINER wrapper
--

CREATE FUNCTION public.is_workspace_member(p_workspace_id uuid, p_min_role text DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT reachagent_private.is_workspace_member(p_workspace_id, p_min_role)
$$;

ALTER FUNCTION public.is_workspace_member(uuid, text) OWNER TO reachagent_function_owner;

--
-- reachagent_private.is_platform_admin()
--

CREATE FUNCTION reachagent_private.is_platform_admin()
RETURNS boolean
LANGUAGE sql STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles AS p
    WHERE p.id = COALESCE(
      NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
      (NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
      AND p.role = 'admin'
      AND p.is_active = true
  )
$$;

ALTER FUNCTION reachagent_private.is_platform_admin() OWNER TO reachagent_function_owner;

--
-- public.is_platform_admin(): SECURITY DEFINER wrapper
--

CREATE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT reachagent_private.is_platform_admin()
$$;

ALTER FUNCTION public.is_platform_admin() OWNER TO reachagent_function_owner;

--
-- Grants: authenticated reads tenancy metadata; service_role retains full access.
--

REVOKE ALL ON TABLE public.workspaces, public.workspace_members, public.workspace_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.workspaces TO authenticated;
GRANT SELECT ON TABLE public.workspace_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workspace_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workspaces TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workspace_members TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workspace_settings TO service_role;
GRANT ALL ON TABLE public.workspaces, public.workspace_members, public.workspace_settings TO reachagent_function_owner;

REVOKE ALL ON FUNCTION reachagent_private.is_workspace_member(uuid, text), reachagent_private.is_platform_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_workspace_member(uuid, text), public.is_platform_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_workspace_member(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated, service_role;

REVOKE reachagent_function_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
