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
-- ── Deployment safety: pre-existing duplicates ──────────────────────────────
-- A prior audit found that production may already have more than one
-- delivered ('sent' or 'email_sync_failed') row for the same (lead_id, type)
-- pair — e.g. from a race that existed before the protections above/around
-- this migration were added. CREATE UNIQUE INDEX fails outright if any
-- duplicates violate it, which would abort this migration on deploy and
-- block every migration after it.
--
-- The DO block below runs first, in the same migration, and resolves this
-- automatically and non-destructively:
--   - No row is ever deleted and no email content is modified.
--   - For every (lead_id, type) group with more than one delivered row, the
--     EARLIEST delivery (by sent_at, the row that represents what the
--     recipient actually received first) is left untouched.
--   - Every OTHER delivered row in that group has its `status` changed to
--     'failed' — the same status the app already assigns at runtime when its
--     own idempotency check finds a lead already sent to (see the
--     `alreadySent` branch in agents/sender.ts). This is a label change only;
--     resend_id/message_id/sent_at/subject/body are all preserved for audit,
--     and 'failed' rows are excluded from every automated send query, so
--     nothing gets re-sent as a result.
--   - A single activity_log row (event_type = 'duplicate_delivered_emails_resolved')
--     records how many rows were demoted, for anyone reviewing the deploy.
--
-- What happens when this migration is deployed:
--   1. If there are no duplicates (the expected case), the DO block is a
--      no-op (0 rows match) and CREATE UNIQUE INDEX proceeds immediately.
--   2. If duplicates exist, they are demoted as described above in the same
--      transaction as the index creation, so the index build can never fail
--      here and no manual intervention is required.
--   3. To review what would be affected before deploying, run the read-only
--      diagnostic query on its own against production first:
--        SELECT lead_id, type, COUNT(*) FROM emails
--        WHERE status IN ('sent', 'email_sync_failed')
--        GROUP BY lead_id, type HAVING COUNT(*) > 1;
DO $$
DECLARE
  demoted_count INT;
BEGIN
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY lead_id, type
             ORDER BY sent_at ASC NULLS LAST, created_at ASC
           ) AS rn
    FROM emails
    WHERE status IN ('sent', 'email_sync_failed')
  ),
  demoted AS (
    UPDATE emails
    SET status = 'failed'
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    RETURNING id
  )
  SELECT count(*) INTO demoted_count FROM demoted;

  IF demoted_count > 0 THEN
    RAISE NOTICE 'migration 027: demoted % duplicate delivered email row(s) to status=failed (kept earliest delivery per lead_id+type) before creating emails_lead_type_delivered_key', demoted_count;

    INSERT INTO activity_log (event_type, description, metadata)
    VALUES (
      'duplicate_delivered_emails_resolved',
      format('Migration 027 demoted %s duplicate delivered email row(s) to status=failed (kept earliest delivery per lead+type) so the new unique index could be created', demoted_count),
      jsonb_build_object('count', demoted_count)
    );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS emails_lead_type_delivered_key
  ON emails (lead_id, type)
  WHERE status IN ('sent', 'email_sync_failed');
