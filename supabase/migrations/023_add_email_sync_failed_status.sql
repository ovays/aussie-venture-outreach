-- Add email_sync_failed to the emails.status CHECK constraint.
ALTER TABLE emails DROP CONSTRAINT IF EXISTS emails_status_check;
ALTER TABLE emails ADD CONSTRAINT emails_status_check
  CHECK (status IN ('pending_send', 'sent', 'failed', 'bounced', 'email_sync_failed'));
