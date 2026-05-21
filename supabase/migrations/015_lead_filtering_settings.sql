-- Global lead filtering settings.
-- Before scraping a business website, the finder agent checks these to skip unwanted businesses.

INSERT INTO settings (key, value, description) VALUES
  ('enable_lead_filtering', 'false', 'Enable global lead filtering — skip businesses whose name contains a blocked keyword'),
  ('blocked_business_keywords', '[]', 'JSON array of blocked business name keywords (lowercase, matched by inclusion)')
ON CONFLICT (key) DO NOTHING;
