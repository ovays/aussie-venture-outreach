-- Extend leads status to support manual close, and add structured halal reason storage.

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check
  CHECK (status IN ('new', 'researched', 'email_ready', 'contacted', 'replied', 'negotiating', 'closed', 'closed_manual', 'dead'));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS halal_reasons JSONB;
