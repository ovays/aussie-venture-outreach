-- ReachAgent SaaS 1A: workspace-scoped row-level security.
--
-- Replaces the single-tenant global member/admin policies on workspace-owned
-- tables with workspace-scoped policies driven by authoritative membership.
-- Platform admins retain cross-workspace access; ordinary members only touch
-- rows in workspaces where they hold an active membership row.

-- 1. Drop legacy global policies on every workspace-owned table.
DO $$
DECLARE
  t text;
  pol record;
  tables text[] := ARRAY[
    'leads',
    'emails',
    'deals',
    'dm_queue',
    'follow_ups',
    'categories',
    'category_email_templates',
    'category_suburb_priorities',
    'category_suburb_search_state',
    'city_suburbs',
    'recipient_outreach_ownership',
    'lead_data_quality_flags',
    'activity_log',
    'inbound_receipts',
    'discovery_run_metrics',
    'exhausted_queries',
    'search_cache',
    'dead_letter_queue',
    'distributed_locks',
    'ai_request_logs',
    'workflow_runs',
    'workflow_steps'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    FOR pol IN
      SELECT p.polname
      FROM pg_catalog.pg_policy AS p
      WHERE p.polrelid = format('public.%I', t)::regclass
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.polname, t);
    END LOOP;
  END LOOP;
END
$$;

-- 2. Configuration-ish tenant tables: workspace admin manages, member reads.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['categories', 'category_email_templates', 'category_suburb_priorities', 'city_suburbs'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_workspace_member(workspace_id, ''admin'') OR public.is_platform_admin()) WITH CHECK (public.is_workspace_member(workspace_id, ''admin'') OR public.is_platform_admin())',
      t || '_admin_manage',
      t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id) OR public.is_platform_admin())',
      t || '_member_read',
      t
    );
  END LOOP;
END
$$;

-- 3. Lead/outreach operational tables: member insert/read/update, admin delete.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['deals', 'dm_queue', 'follow_ups', 'leads'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.is_workspace_member(workspace_id) OR public.is_platform_admin())',
      t || '_member_insert',
      t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id) OR public.is_platform_admin())',
      t || '_member_read',
      t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.is_workspace_member(workspace_id) OR public.is_platform_admin()) WITH CHECK (public.is_workspace_member(workspace_id) OR public.is_platform_admin())',
      t || '_member_update',
      t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.is_workspace_member(workspace_id, ''admin'') OR public.is_platform_admin())',
      t || '_admin_delete',
      t
    );
  END LOOP;
END
$$;

-- 4. Operational/observability tables: workspace admin read.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'category_suburb_search_state',
    'dead_letter_queue',
    'discovery_run_metrics',
    'exhausted_queries',
    'inbound_receipts',
    'search_cache',
    'ai_request_logs',
    'workflow_runs',
    'workflow_steps'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, ''admin'') OR public.is_platform_admin())',
      t || '_admin_read',
      t
    );
  END LOOP;
END
$$;

-- 5. Member-readable workspace-owned tables.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['emails', 'lead_data_quality_flags', 'recipient_outreach_ownership'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id) OR public.is_platform_admin())',
      t || '_member_read',
      t
    );
  END LOOP;
END
$$;

-- 6. activity_log: member append + member read.
CREATE POLICY activity_member_append ON public.activity_log FOR INSERT TO authenticated
  WITH CHECK (public.is_workspace_member(workspace_id) OR public.is_platform_admin());
CREATE POLICY activity_member_read ON public.activity_log FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id) OR public.is_platform_admin());

-- 7. Tenancy tables: RLS + policies.
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspaces_member_read ON public.workspaces FOR SELECT TO authenticated
  USING (public.is_workspace_member(id) OR public.is_platform_admin());

CREATE POLICY workspace_members_read ON public.workspace_members FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_workspace_member(workspace_id, 'admin') OR public.is_platform_admin());

CREATE POLICY workspace_members_manage ON public.workspace_members FOR ALL TO authenticated
  USING (public.is_workspace_member(workspace_id, 'admin') OR public.is_platform_admin())
  WITH CHECK (public.is_workspace_member(workspace_id, 'admin') OR public.is_platform_admin());

CREATE POLICY workspace_settings_admin_manage ON public.workspace_settings FOR ALL TO authenticated
  USING (public.is_workspace_member(workspace_id, 'admin') OR public.is_platform_admin())
  WITH CHECK (public.is_workspace_member(workspace_id, 'admin') OR public.is_platform_admin());

CREATE POLICY workspace_settings_member_read_allowlist ON public.workspace_settings FOR SELECT TO authenticated
  USING (
    public.is_workspace_member(workspace_id)
    AND key = ANY (ARRAY[
      'initial_email_mode'::text,
      'active_cities'::text,
      'blocked_business_keywords'::text,
      'enable_lead_filtering'::text,
      'daily_dm_limit'::text,
      'daily_initial_outreach_limit'::text,
      'daily_followup1_limit'::text,
      'daily_followup2_limit'::text,
      'daily_followup3_limit'::text,
      'daily_lead_limit'::text,
      'daily_reactivation_limit'::text,
      'dead_after_reactivation_days'::text,
      'dead_lead_days'::text,
      'reactivation_delay_days'::text,
      'reactivation_enabled'::text,
      'follow_up_1_days'::text,
      'follow_up_2_days'::text,
      'follow_up_3_days'::text
    ])
  );
