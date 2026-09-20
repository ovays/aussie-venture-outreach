-- ReachAgent SaaS 1A: tenant table workspace_id wiring.
--
-- Adds a nullable workspace_id to every workspace-owned table, backfills the
-- seed workspace, then locks the column NOT NULL with a foreign key. This keeps
-- existing single-tenant data intact under the seed workspace and makes the
-- tenancy boundary fail closed for any writer that does not yet supply a
-- workspace_id (application wiring is completed in SaaS 1B).

DO $$
DECLARE
  t text;
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
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS workspace_id uuid', t);
  END LOOP;

  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'UPDATE public.%I SET workspace_id = (SELECT id FROM public.workspaces WHERE slug = ''aussie-venture'') WHERE workspace_id IS NULL',
      t
    );
  END LOOP;

  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN workspace_id SET NOT NULL', t);
  END LOOP;

  -- Transitional default: existing single-tenant writer functions and fixtures
  -- do not yet supply workspace_id. Defaulting to the seed workspace keeps the
  -- NOT NULL boundary while preserving current behavior; SaaS 1B removes this
  -- default once every writer resolves workspace_id explicitly.
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN workspace_id SET DEFAULT ''00000000-0000-0000-0000-000000000001''::uuid',
      t
    );
  END LOOP;

  FOREACH t IN ARRAY tables LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint
      WHERE conname = t || '_workspace_id_fkey'
        AND conrelid = format('public.%I', t)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT',
        t,
        t || '_workspace_id_fkey'
      );
    END IF;
  END LOOP;
END
$$;

-- Seed membership: every existing profile becomes a member of the seed
-- workspace. The existing platform admin becomes the seed workspace owner;
-- inactive profiles are seeded as suspended.
INSERT INTO public.workspace_members (workspace_id, user_id, role, status)
SELECT
  '00000000-0000-0000-0000-000000000001'::uuid,
  p.id,
  CASE WHEN p.role = 'admin' THEN 'owner' ELSE 'member' END,
  CASE WHEN p.is_active THEN 'active' ELSE 'suspended' END
FROM public.profiles AS p
ON CONFLICT (workspace_id, user_id) DO UPDATE
SET role = EXCLUDED.role,
    status = EXCLUDED.status,
    updated_at = now();
