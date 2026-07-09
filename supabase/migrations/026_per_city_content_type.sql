-- Per-city content type (Visit vs Remote).
-- categories.content_type stays as the per-category default; city_content_types is an
-- optional per-city override map, e.g. {"Sydney": "visit", "Melbourne": "remote"}.
-- NULL (all existing rows) means "not configured yet" — resolver falls back to the
-- legacy Sydney + VISIT_ELIGIBLE_CATEGORIES rule the app already applies today.
ALTER TABLE categories ADD COLUMN city_content_types JSONB;

-- leads.content_type is resolved once at lead-creation time instead of being
-- recomputed ad hoc on every draft/resend/regenerate call.
ALTER TABLE leads ADD COLUMN content_type TEXT CHECK (content_type IN ('visit', 'remote'));

-- Backfill existing leads using the exact legacy rule the app already applies today,
-- so historical rows keep behaving identically after this migration.
UPDATE leads SET content_type = CASE
  WHEN lower(city) = 'sydney' AND category_name IN (
    'Halal Restaurants', 'Halal Cafes', 'Halal Bakeries / Dessert Shops',
    'Nail Salons', 'Hair Salons', 'Beauty / Lash Studios',
    'Spas / Massage Studios', 'Hotels / Resorts'
  ) THEN 'visit'
  ELSE 'remote'
END
WHERE content_type IS NULL;
