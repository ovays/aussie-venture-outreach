-- Add a UNIQUE constraint on emails.resend_id so that
-- insertEmailSyncFailedRecovery() can upsert on conflict and be
-- intrinsically idempotent regardless of retry semantics.
--
-- NULL values are exempt from UNIQUE in PostgreSQL (multiple NULLs coexist),
-- so this only enforces uniqueness for rows that actually have a resend_id —
-- which is exactly the set that insertEmailSyncFailedRecovery() writes.
ALTER TABLE emails
  ADD CONSTRAINT emails_resend_id_key UNIQUE (resend_id);
