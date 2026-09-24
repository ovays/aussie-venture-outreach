-- ReachAgent SaaS 4: deterministic, workspace-scoped category policy.
--
-- Policy remains 1:1 with a category, so it extends categories rather than
-- introducing a second ownership/tenancy surface. The existing halal_filter
-- column is retained as the authoritative "requires halal confirmation" flag.

ALTER TABLE public.categories
  ADD COLUMN exclude_alcohol_focused boolean NOT NULL DEFAULT false,
  ADD COLUMN exclude_pork boolean NOT NULL DEFAULT false,
  ADD COLUMN exclude_gambling boolean NOT NULL DEFAULT false,
  ADD COLUMN exclude_religious_institutions boolean NOT NULL DEFAULT false,
  ADD COLUMN exclude_shisha boolean NOT NULL DEFAULT false,
  ADD COLUMN custom_policy_instructions text;

ALTER TABLE public.categories
  ADD CONSTRAINT categories_custom_policy_instructions_length_check
  CHECK (custom_policy_instructions IS NULL OR length(custom_policy_instructions) <= 2000);

COMMENT ON COLUMN public.categories.halal_filter IS
  'Authoritative category policy switch: require structured halal confirmation before outreach.';
COMMENT ON COLUMN public.categories.custom_policy_instructions IS
  'Human-readable research/manual-review context only. Never interpreted as an automated policy rule.';

ALTER TABLE public.leads
  ADD COLUMN category_policy_facts jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.leads
  ADD CONSTRAINT leads_category_policy_facts_check CHECK (
    jsonb_typeof(category_policy_facts) = 'object'
    AND (
      NOT category_policy_facts ? 'halalStatus'
      OR category_policy_facts ->> 'halalStatus' IN ('confirmed', 'not_halal', 'unknown', 'not_applicable')
    )
    AND (
      NOT category_policy_facts ? 'alcoholFocus'
      OR category_policy_facts ->> 'alcoholFocus' IN ('focused', 'serves_alcohol', 'no_evidence', 'unknown', 'not_applicable')
    )
    AND (
      NOT category_policy_facts ? 'porkEvidence'
      OR category_policy_facts ->> 'porkEvidence' IN ('confirmed_incompatible', 'no_evidence', 'unknown', 'not_applicable')
    )
    AND (
      NOT category_policy_facts ? 'gamblingBusiness'
      OR category_policy_facts ->> 'gamblingBusiness' IN ('confirmed', 'not_gambling', 'unknown', 'not_applicable')
    )
    AND (
      NOT category_policy_facts ? 'religiousInstitution'
      OR category_policy_facts ->> 'religiousInstitution' IN ('confirmed', 'not_religious_institution', 'unknown', 'not_applicable')
    )
    AND (
      NOT category_policy_facts ? 'shishaFocused'
      OR category_policy_facts ->> 'shishaFocused' IN ('confirmed', 'not_shisha_focused', 'unknown', 'not_applicable')
    )
  );

COMMENT ON COLUMN public.leads.category_policy_facts IS
  'Verified structured facts consumed by the deterministic category policy evaluator. Missing fields mean unknown.';

-- Make category tenancy structural for all future lead inserts/updates. NOT
-- VALID avoids rewriting or silently changing legacy rows during this additive
-- phase, while PostgreSQL still enforces the constraint for new data.
ALTER TABLE public.categories
  ADD CONSTRAINT categories_workspace_id_id_unique UNIQUE (workspace_id, id);

ALTER TABLE public.leads
  ADD CONSTRAINT leads_workspace_category_fkey
  FOREIGN KEY (workspace_id, category_id)
  REFERENCES public.categories (workspace_id, id)
  NOT VALID;
