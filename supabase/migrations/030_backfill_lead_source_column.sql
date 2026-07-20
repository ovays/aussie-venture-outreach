-- Migration 021_add_lead_source.sql only ever contained a comment — it never
-- actually ran `ALTER TABLE leads ADD COLUMN source`. Production almost
-- certainly has this column already (it was very likely added out-of-band,
-- e.g. via the Supabase SQL editor, since manual lead creation and the
-- sender agent's `.neq('leads.source', 'manual')` filter already depend on
-- it and are working in production today). But the migration *files* — the
-- source of truth for reconstructing the schema from scratch — do not
-- create it. Any environment built by replaying migrations 001-029 in order
-- (a fresh staging DB, disaster recovery, `supabase db reset`) would be
-- missing `leads.source` and immediately break manual lead creation
-- (src/app/api/leads/route.ts) and silently zero out the sender agent's
-- initial-outreach stage (agents/sender.ts filters on this column).
--
-- IF NOT EXISTS makes this safe to run against production as a no-op (column
-- already present) while fixing every environment rebuilt from these files.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS source TEXT;

COMMENT ON COLUMN leads.source IS 'How a lead entered the system: NULL = finder pipeline (legacy), ''manual'' = manually added via UI';
