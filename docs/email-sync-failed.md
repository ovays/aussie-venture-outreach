# Email Sync Failure Recovery

## Background

The normal send flow is:

1. Resend accepts the email.
2. The email row is updated: `status = sent`, `resend_id`, `sent_at`.
3. Lead status is updated to `contacted`.
4. Activity log is written.

Historically, if step 2 failed the system continued processing, leaving inconsistent state and making duplicate sends possible.

## email_sync_failed

`email_sync_failed` means:

> Resend successfully accepted the email, but the database could not complete the normal transition to `status = 'sent'`.

It does **not** mean the email failed to send. The email was delivered.

## Recovery flow

```
Resend accepts email
  → DB update to status='sent' fails
  → handleEmailSyncFailure() (src/lib/email-status.ts)
      → email row: status=email_sync_failed, resend_id, sent_at preserved
      → lead: status=contacted (best-effort)
  → operator runs repair script (scripts/repair-email-sync-failed.sql) if desired
      → email_sync_failed → sent
      → activity_log entry written
```

For paths where the email row does not yet exist (follow-up, reactivation), `insertEmailSyncFailedRecovery()` inserts a recovery row instead of updating one.

## Why resend_id is UNIQUE

A `resend_id` uniquely identifies one delivery accepted by Resend — there is no scenario in which two distinct delivered emails share a `resend_id`.

The `UNIQUE` constraint on `emails.resend_id` (migration 024) enforces database-level idempotency: `insertEmailSyncFailedRecovery()` uses `upsert({ onConflict: 'resend_id', ignoreDuplicates: true })`, so a second call with the same `resend_id` is a no-op at the database level. This holds regardless of retry behaviour by the task runner.

`NULL` values are exempt from `UNIQUE` in PostgreSQL, so rows that have not yet been sent (no `resend_id`) are unaffected.

## Why DO NOTHING instead of DO UPDATE

The first successful recovery row represents the email that was actually delivered. Subsequent retries must never overwrite `subject`, `body_html`, `body_text`, or `sent_at`, because those fields describe the message Resend accepted — not a later retry's regenerated copy.

`DO NOTHING` (`ignoreDuplicates: true`) treats "row already exists" as "goal already achieved" and stops. `DO UPDATE` would silently replace delivered-email data with potentially different regenerated content, which is incorrect.

## Runtime protections

| Protection | Where |
|---|---|
| Sender idempotency | `agents/sender.ts` — skips leads with `sent` or `email_sync_failed` email rows |
| Writer stale-reset exclusion | `agents/writer.ts` — does not reset `email_ready` leads that have `email_sync_failed` rows |
| Resend 409 guard | `src/app/api/leads/[id]/resend/route.ts` — returns 409 if an `email_sync_failed` row exists |
| UNIQUE(resend_id) | Migration 024 — prevents duplicate recovery rows at the DB level |
| `email_sync_failed` recovery | `src/lib/email-status.ts` — `handleEmailSyncFailure` and `insertEmailSyncFailedRecovery` |

## Historical repair

`scripts/repair-email-sync-failed.sql` repairs existing `email_sync_failed` rows. It:

- **never resends emails** — it only updates status in the database
- only promotes rows where `resend_id` is present and `sent_at` is set (or an `activity_log` entry confirms delivery)
- promotes `email_sync_failed → sent` and advances the lead to `contacted` if needed
- writes an `email_sync_repaired` entry to `activity_log`

Run the diagnostic section first, review the output, then uncomment the `APPLY` section inside a transaction. Only run after the runtime protections above have been deployed, so the repaired rows are immediately protected from re-send.

## Adding new send paths

- Always check the result of every Supabase write after a Resend call.
- Never bypass `handleEmailSyncFailure()` on update paths or `insertEmailSyncFailedRecovery()` on insert paths.
- Never resend an email once Resend has accepted it — a delivered email with a broken DB record is an `email_sync_failed` row, not a retryable failure.
- Preserve `resend_id` uniqueness: one Resend delivery = one email row.
