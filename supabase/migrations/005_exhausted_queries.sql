CREATE TABLE IF NOT EXISTS exhausted_queries (
  query TEXT PRIMARY KEY,
  city TEXT NOT NULL,
  category TEXT NOT NULL,
  exhausted_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT now() + interval '3 days'
);

ALTER TABLE exhausted_queries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users have full access" ON exhausted_queries FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON exhausted_queries FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO settings (key, value, description)
VALUES ('daily_outscraper_limit', '2.00', 'Maximum Outscraper spend per day in USD. Pipeline stops when reached. Normal daily cost is ~$0.50. Set to $2.00 for safety margin.')
ON CONFLICT (key) DO NOTHING;
