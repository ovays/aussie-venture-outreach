ALTER TABLE leads
ADD COLUMN IF NOT EXISTS halal_confidence_score INTEGER;
