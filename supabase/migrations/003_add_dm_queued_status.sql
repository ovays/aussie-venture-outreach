-- Add dm_queued to leads status constraint (Instagram-only leads after writer queues DM)
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check CHECK (
  status IN ('new', 'researched', 'email_ready', 'contacted', 'replied', 'negotiating', 'closed', 'dead', 'dm_queued')
);
