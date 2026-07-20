-- Email threading + duplicate-send prevention.
--
-- 1. message_id: the RFC 5322 Message-ID we generate for each outbound send
--    (see src/lib/resend.ts). Stored so a later follow-up in the same thread
--    can set In-Reply-To/References and thread correctly in the recipient's
--    inbox. Nullable — existing rows have no message_id and simply won't be
--    referenced by a future follow-up's In-Reply-To (graceful degrade, no
--    backfill needed).
ALTER TABLE emails ADD COLUMN IF NOT EXISTS message_id TEXT;

-- 2. Duplicate-send prevention: at most one delivered row per (lead_id, type).
--    'sent' and 'email_sync_failed' both mean Resend actually delivered the
--    email (see src/lib/email-status.ts), so both count as "already sent" for
--    this constraint. 'failed'/'pending_send' rows are NOT restricted, so a
--    retry after a genuine failure can still insert a fresh row for the same
--    lead+type.
--
--    This is the DB-level backstop against two overlapping scheduler runs
--    (or a Trigger.dev retry racing a still-in-flight run) both delivering
--    the same follow-up — or initial pitch — to the same lead. Application
--    code re-checks before sending (see agents/followup.ts sendFollowUp);
--    this index is the last line of defense if that check loses a race.
--
--    NOTE: if this fails to apply because duplicate delivered rows already
--    exist for some (lead_id, type) pair, run this first to find them:
--      SELECT lead_id, type, COUNT(*) FROM emails
--      WHERE status IN ('sent', 'email_sync_failed')
--      GROUP BY lead_id, type HAVING COUNT(*) > 1;
--    and resolve (or accept) the duplicates before re-running this migration.
CREATE UNIQUE INDEX IF NOT EXISTS emails_lead_type_delivered_key
  ON emails (lead_id, type)
  WHERE status IN ('sent', 'email_sync_failed');
