CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operation  TEXT        NOT NULL,
  payload    JSONB       NOT NULL DEFAULT '{}',
  error      TEXT,
  resolved   BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

ALTER TABLE dead_letter_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users have full access" ON dead_letter_queue FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON dead_letter_queue FOR ALL TO service_role USING (true) WITH CHECK (true);
