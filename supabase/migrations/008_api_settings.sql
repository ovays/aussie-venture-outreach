-- Migration 008: Dual API settings and search result cache

INSERT INTO settings (key, value, description) VALUES
  ('google_maps_cost_per_request', '0.032', 'Google Maps API cost per request in USD — update if pricing changes'),
  ('primary_search_api', 'google_maps', 'Primary API: google_maps or outscraper'),
  ('google_maps_monthly_limit', '180', 'Switch to Outscraper when Google spend exceeds this'),
  ('google_maps_spend_this_month', '0.0000', 'Tracked Google Maps spend this month'),
  ('google_maps_spend_reset_month', '', 'Last month spend was reset (YYYY-MM format)')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS search_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query TEXT NOT NULL,
  results JSONB NOT NULL,
  api_used TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT now() + interval '7 days'
);

CREATE UNIQUE INDEX IF NOT EXISTS search_cache_query_idx ON search_cache(query);
ALTER TABLE search_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users have full access" ON search_cache FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON search_cache FOR ALL TO service_role USING (true) WITH CHECK (true);
