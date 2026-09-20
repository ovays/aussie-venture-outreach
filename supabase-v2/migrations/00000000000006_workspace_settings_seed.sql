-- ReachAgent SaaS 1A: seed workspace settings.
--
-- Copies tenant-scoped business/limits/follow-up configuration into
-- workspace_settings for the seed workspace. The original rows remain in the
-- legacy public.settings table during this foundation phase so the existing
-- single-tenant application keeps reading them; SaaS 1B switches the app layer
-- to workspace_settings and removes these tenant keys from public.settings.

INSERT INTO public.workspace_settings (workspace_id, key, value, description, updated_at)
SELECT
  '00000000-0000-0000-0000-000000000001'::uuid,
  s.key,
  s.value,
  s.description,
  COALESCE(s.updated_at, now())
FROM public.settings AS s
WHERE s.key = ANY (ARRAY[
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
  'digest_email'::text,
  'follow_up_1_days'::text,
  'follow_up_2_days'::text,
  'follow_up_3_days'::text
])
ON CONFLICT (workspace_id, key) DO UPDATE
SET value = EXCLUDED.value,
    description = EXCLUDED.description,
    updated_at = EXCLUDED.updated_at;
