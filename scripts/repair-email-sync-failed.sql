-- =============================================================================
-- scripts/repair-email-sync-failed.sql
--
-- Safely repairs emails.status = 'email_sync_failed' rows ONLY where delivery
-- can be confirmed from evidence already in the database.
--
-- What this script does (READ-ONLY by default — see APPLY section below):
--   1. Identifies sync-failed rows where resend_id is present AND either:
--      a. The activity_log records an 'email_sent' event for the same lead, OR
--      b. The row already has sent_at set (recovery inserted sentAt directly)
--   2. Promotes confirmed rows to status='sent'
--   3. Ensures the lead is in 'contacted' status
--   4. Logs a repair event to activity_log
--
-- What this script does NOT do:
--   • Does NOT re-send any emails
--   • Does NOT modify leads unnecessarily (only sets contacted if they aren't)
--   • Does NOT touch rows with no resend_id (truly unknown — operator must
--     check Resend dashboard manually before promoting)
--
-- Usage:
--   Step 1: Run the DIAGNOSTIC section to review affected rows.
--   Step 2: Confirm the resend_ids in the Resend dashboard if desired.
--   Step 3: Uncomment the APPLY section and run inside a transaction.
--
-- Run inside Supabase SQL editor or psql. Always wrap in BEGIN/ROLLBACK first
-- to preview, then BEGIN/COMMIT to apply.
-- =============================================================================

-- ─── DIAGNOSTIC (safe to run anytime) ───────────────────────────────────────

-- 1a. All email_sync_failed rows
SELECT
  e.id              AS email_id,
  e.lead_id,
  l.business_name,
  l.status          AS lead_status,
  e.type,
  e.subject,
  e.resend_id,
  e.sent_at,
  e.created_at
FROM emails e
JOIN leads  l ON l.id = e.lead_id
WHERE e.status = 'email_sync_failed'
ORDER BY e.created_at DESC;


-- 1b. Subset that can be auto-repaired:
--     resend_id is present AND (sent_at is set OR activity_log confirms delivery)
SELECT
  e.id              AS email_id,
  e.lead_id,
  l.business_name,
  l.status          AS lead_status,
  e.type,
  e.resend_id,
  e.sent_at,
  CASE
    WHEN e.sent_at IS NOT NULL                       THEN 'sent_at_present'
    WHEN a.lead_id IS NOT NULL                       THEN 'activity_log_confirmed'
    ELSE 'needs_manual_review'
  END               AS confirmation_source
FROM emails e
JOIN leads  l ON l.id = e.lead_id
LEFT JOIN LATERAL (
  SELECT lead_id FROM activity_log
  WHERE lead_id   = e.lead_id
    AND event_type = 'email_sent'
  LIMIT 1
) a ON true
WHERE e.status    = 'email_sync_failed'
  AND e.resend_id IS NOT NULL
ORDER BY e.created_at DESC;


-- 1c. Rows that CANNOT be auto-repaired (no resend_id, needs Resend dashboard check)
SELECT
  e.id     AS email_id,
  e.lead_id,
  l.business_name,
  e.type,
  e.created_at
FROM emails e
JOIN leads  l ON l.id = e.lead_id
WHERE e.status    = 'email_sync_failed'
  AND e.resend_id IS NULL
ORDER BY e.created_at DESC;


-- =============================================================================
-- APPLY SECTION
-- Uncomment and run inside BEGIN / COMMIT after reviewing diagnostics above.
-- =============================================================================

/*
BEGIN;

-- Step A: Promote confirmable rows to 'sent'.
--         Only touches rows where resend_id is set AND
--         (sent_at is already set OR activity_log confirms delivery).
WITH confirmable AS (
  SELECT e.id AS email_id, e.lead_id, e.sent_at AS original_sent_at
  FROM emails e
  LEFT JOIN LATERAL (
    SELECT 1 FROM activity_log
    WHERE lead_id   = e.lead_id
      AND event_type = 'email_sent'
    LIMIT 1
  ) a ON true
  WHERE e.status    = 'email_sync_failed'
    AND e.resend_id IS NOT NULL
    AND (e.sent_at IS NOT NULL OR a IS NOT NULL)
)
UPDATE emails
SET
  status  = 'sent',
  -- Preserve original sent_at if present; fall back to now() only if null
  sent_at = COALESCE(emails.sent_at, now())
FROM confirmable
WHERE emails.id = confirmable.email_id;


-- Step B: Advance leads to 'contacted' if they aren't already
--         (only for leads that now have a 'sent' initial_pitch email).
UPDATE leads
SET status = 'contacted'
WHERE status IN ('email_ready', 'researched', 'new')
  AND id IN (
    SELECT DISTINCT lead_id
    FROM emails
    WHERE status = 'sent'
      AND type   = 'initial_pitch'
  );


-- Step C: Log the repair in activity_log for each repaired email.
INSERT INTO activity_log (event_type, lead_id, description, metadata)
SELECT
  'email_sync_repaired',
  e.lead_id,
  'email_sync_failed row promoted to sent by repair script',
  jsonb_build_object(
    'email_id',  e.id,
    'resend_id', e.resend_id,
    'type',      e.type,
    'repaired_at', now()
  )
FROM emails e
WHERE e.status = 'sent'
  AND e.id IN (
    -- Re-select the rows we just repaired (now status='sent') via resend_id presence
    SELECT id FROM emails
    WHERE status    = 'sent'
      AND resend_id IS NOT NULL
      -- Narrow to recently-updated rows within the last minute to avoid touching
      -- pre-existing sent rows. Adjust window if running long after the failure.
      AND updated_at > now() - interval '1 minute'
  );


-- Preview what will change before committing:
-- SELECT * FROM emails WHERE status = 'email_sync_failed';  -- should be empty or reduced
-- SELECT * FROM activity_log WHERE event_type = 'email_sync_repaired' ORDER BY created_at DESC LIMIT 20;

COMMIT;
-- Replace COMMIT with ROLLBACK to do a dry run.
*/
