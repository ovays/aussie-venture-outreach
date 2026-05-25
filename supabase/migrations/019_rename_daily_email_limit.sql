-- Rename daily_email_limit → daily_initial_outreach_limit.
-- The old key controlled all outreach emails; the new name clarifies it only caps
-- initial cold outreach. Follow-up queues have their own independent limits.
UPDATE settings
SET
  key         = 'daily_initial_outreach_limit',
  description = 'Maximum initial cold outreach emails to send per day (does not affect follow-up queues)'
WHERE key = 'daily_email_limit';
