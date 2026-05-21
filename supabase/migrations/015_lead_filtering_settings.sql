-- Global lead filtering settings.
-- Before scraping a business website, the finder agent checks these to skip unwanted businesses.

INSERT INTO settings (key, value, description) VALUES
  ('enable_lead_filtering', 'false', 'Enable global lead filtering — skip businesses matching blocked keywords or Google Maps categories before scraping'),
  ('blocked_business_keywords', '[]', 'JSON array of blocked business name keywords (lowercase, matched by inclusion)'),
  ('blocked_google_categories', '[]', 'JSON array of blocked Google Maps categories (matched exact or by lowercase inclusion)')
ON CONFLICT (key) DO NOTHING;
