-- Category-linked storage for the existing outreach sequence and the future
-- Initial Email Mode. Runtime generation intentionally does not read these
-- records yet.

CREATE TABLE category_email_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  template_type TEXT NOT NULL CHECK (
    template_type IN ('initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'reactivation')
  ),
  subject_template TEXT,
  body_template TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT category_email_templates_category_type_unique UNIQUE (category_id, template_type)
);

CREATE INDEX category_email_templates_type_idx
  ON category_email_templates (template_type);

CREATE TRIGGER update_category_email_templates_updated_at
  BEFORE UPDATE ON category_email_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE category_email_templates ENABLE ROW LEVEL SECURITY;

-- Templates are global configuration, matching the existing categories and
-- settings model. Authenticated users may read them, active admins may edit
-- them, and background agents use the service role. No anonymous access is
-- granted.
CREATE POLICY "Authenticated users can read" ON category_email_templates
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage" ON category_email_templates
  FOR ALL TO authenticated
  USING (public.is_active_admin())
  WITH CHECK (public.is_active_admin());
CREATE POLICY "Service role can manage" ON category_email_templates
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON category_email_templates FROM anon;
GRANT SELECT ON category_email_templates TO authenticated;
GRANT INSERT, UPDATE, DELETE ON category_email_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON category_email_templates TO service_role;

-- Double-brace placeholders record values that the current hardcoded fallback
-- computes per lead. They are storage-only in this migration; no renderer or
-- runtime path is changed.
--
-- Seed every existing category without inserting or matching categories by
-- name. ON CONFLICT fills only missing values and preserves custom content.
INSERT INTO category_email_templates (
  category_id,
  template_type,
  subject_template,
  body_template
)
SELECT
  categories.id,
  templates.template_type,
  templates.subject_template,
  templates.body_template
FROM categories
CROSS JOIN (
  VALUES
    (
      'follow_up_1',
      'Re: {{initial_subject}}',
      $template$Hey {{business_name}},

I emailed you last week but it may not have reached you.

{{category_reminder}}

I was asking whether you'd want to do a collab with us.

Would you be interested?

Cheers,
Owais$template$
    ),
    (
      'follow_up_2',
      'Re: {{initial_subject}}',
      $template$Hey {{business_name}},

Checking once more in case my earlier emails got buried.

{{category_reminder}}

Is a collab something you'd be interested in? A yes or no is all I need.

Cheers,
Owais$template$
    ),
    (
      'follow_up_3',
      'Re: {{initial_subject}}',
      $template$Hey {{business_name}},

{{follow_up_3_closing}}

{{category_reminder}}

If a collab is something you'd want to look at later, reply any time and I'll pick it back up.

Cheers,
Owais$template$
    ),
    (
      'reactivation',
      '{{reactivation_subject}}',
      $template$Hey {{business_name}},

{{brand_intro}}

I emailed you about a collab a few months back and never heard anything. {{reactivation_context}}

{{reactivation_ask}}

Cheers,
Owais
Aussie Venture
aussieventure.com
instagram.com/aussie.venture$template$
    )
) AS templates(template_type, subject_template, body_template)
ON CONFLICT (category_id, template_type) DO UPDATE SET
  subject_template = COALESCE(category_email_templates.subject_template, EXCLUDED.subject_template),
  body_template = COALESCE(category_email_templates.body_template, EXCLUDED.body_template)
WHERE category_email_templates.subject_template IS NULL
   OR category_email_templates.body_template IS NULL;

-- Persist the future mode without overwriting a value that may already have
-- been inserted by a controlled rollout.
INSERT INTO settings (key, value, description)
VALUES (
  'initial_email_mode',
  'ai_personalised',
  'Controls whether initial emails use AI personalisation or category templates'
)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE settings
  ADD CONSTRAINT settings_initial_email_mode_value_check
  CHECK (key <> 'initial_email_mode' OR value IN ('ai_personalised', 'template'));

-- Nullable for legacy records. Runtime generation will populate this only in
-- the later routing change, so no historical row is guessed or backfilled.
ALTER TABLE emails
  ADD COLUMN generation_source TEXT;

ALTER TABLE emails
  ADD CONSTRAINT emails_generation_source_check
  CHECK (generation_source IS NULL OR generation_source IN ('ai', 'template'));

-- The live audit was clean, but deployment data can change. Create the category
-- uniqueness backstop only when trimmed, case-insensitive duplicates are absent;
-- otherwise leave every category untouched and report the controlled-cleanup
-- requirement as a migration notice.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM categories
    GROUP BY lower(btrim(name))
    HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'migration 037: category name duplicates found after trim/lower normalization; categories_name_trimmed_lower_key was not created';
  ELSE
    CREATE UNIQUE INDEX categories_name_trimmed_lower_key
      ON categories (lower(btrim(name)));
  END IF;
END $$;

-- pending_send is the repository's only draft/queued status. Failed and bounced
-- rows remain retryable history and delivered rows are protected separately by
-- migration 027. Do not mutate duplicates. Abort safely if the read-only
-- pre-deployment check was missed, rather than silently deploying without the
-- concurrency backstop.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM emails
    WHERE type = 'initial_pitch'
      AND status = 'pending_send'
    GROUP BY lead_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'migration 037: duplicate pending initial emails found; resolve them before rerunning so the uniqueness constraint is never skipped';
  END IF;
END $$;

CREATE UNIQUE INDEX emails_one_pending_initial_per_lead_key
  ON emails (lead_id)
  WHERE type = 'initial_pitch' AND status = 'pending_send';
