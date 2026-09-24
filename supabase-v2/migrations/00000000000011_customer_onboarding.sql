-- ReachAgent SaaS 3: durable workspace-scoped onboarding state.
--
-- Existing workspaces are deliberately backfilled as complete so the migration
-- never interrupts an already configured tenant. Workspaces provisioned after
-- this migration have no status row and are interpreted as not_started.

INSERT INTO public.workspace_settings (workspace_id, key, value, description, updated_at)
SELECT id, 'onboarding_status', 'completed', 'ReachAgent customer onboarding', now()
FROM public.workspaces
ON CONFLICT (workspace_id, key) DO NOTHING;

INSERT INTO public.workspace_settings (workspace_id, key, value, description, updated_at)
SELECT id, 'onboarding_current_step', '5', 'ReachAgent customer onboarding', now()
FROM public.workspaces
ON CONFLICT (workspace_id, key) DO NOTHING;

INSERT INTO public.workspace_settings (workspace_id, key, value, description, updated_at)
SELECT id, 'onboarding_completed_at', now()::text, 'ReachAgent customer onboarding', now()
FROM public.workspaces
ON CONFLICT (workspace_id, key) DO NOTHING;
