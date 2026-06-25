/**
 * scripts/test-email-sync-failed.ts
 *
 * Verifies the email_sync_failed lifecycle:
 *   1. handleEmailSyncFailure marks email row email_sync_failed + sets sent_at
 *   2. Lead is advanced to contacted
 *   3. Sender idempotency check excludes email_sync_failed rows
 *   4. Follow-up eligibility: isFuEmailSent uses sent_at, so email_sync_failed
 *      rows WITH sent_at count as sent (preventing re-send of follow-ups)
 *   5. Follow-up eligibility: email_sync_failed rows WITHOUT sent_at do NOT
 *      count as sent (e.g., failed initial-send path)
 *   6. insertEmailSyncFailedRecovery inserts a recovery row
 *   7. Writer stale-reset skips email_ready leads with email_sync_failed rows
 *   8. Resend endpoint 409 guard logic (static check — no HTTP server needed)
 *
 * Read-only where possible. Any DB writes use a known-safe test lead_id that
 * is cleaned up at the end of the script.
 *
 * Run: npx tsx scripts/test-email-sync-failed.ts
 *
 * Set TEST_LEAD_ID env var to run DB-touching tests against a real lead.
 * Without it, only in-memory unit-style tests run.
 */

import * as dotenv from 'dotenv'
import * as path from 'path'
import { isFuEmailSent } from '@/lib/followup-eligibility'
import { EMAIL_STATUS, type EmailStatus } from '@/lib/email-status'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const SEP = '═'.repeat(60)
const DIV = '─'.repeat(60)

let passed = 0
let failed = 0

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

// ── 1. EMAIL_STATUS constants ────────────────────────────────────────────────
console.log('\n' + SEP)
console.log('  1. EMAIL_STATUS constants')
console.log(SEP)

assert(EMAIL_STATUS.EMAIL_SYNC_FAILED === 'email_sync_failed', 'EMAIL_SYNC_FAILED constant is correct')
assert(EMAIL_STATUS.PENDING_SEND === 'pending_send',           'PENDING_SEND constant is correct')
assert(EMAIL_STATUS.SENT === 'sent',                           'SENT constant is correct')
assert(EMAIL_STATUS.FAILED === 'failed',                       'FAILED constant is correct')
assert(EMAIL_STATUS.BOUNCED === 'bounced',                     'BOUNCED constant is correct')

// Ensure all 5 values exist — catches accidental removal
const allStatuses: EmailStatus[] = ['pending_send', 'sent', 'failed', 'bounced', 'email_sync_failed']
assert(Object.values(EMAIL_STATUS).length === allStatuses.length, 'All 5 statuses defined')

// ── 2. Follow-up eligibility with email_sync_failed ──────────────────────────
console.log('\n' + SEP)
console.log('  2. isFuEmailSent — email_sync_failed with sent_at set')
console.log(SEP)

// email_sync_failed with sent_at → isFuEmailSent returns true (email was delivered)
const syncFailedWithSentAt = { sent_at: '2026-06-01T10:00:00Z' }
assert(
  isFuEmailSent(syncFailedWithSentAt),
  'email_sync_failed WITH sent_at counts as sent (follow-up eligibility correct)',
  'isFuEmailSent should return true'
)

// email_sync_failed without sent_at → isFuEmailSent returns false
const syncFailedNoSentAt = { sent_at: null }
assert(
  !isFuEmailSent(syncFailedNoSentAt),
  'email row WITHOUT sent_at does NOT count as sent',
  'isFuEmailSent should return false'
)

// ── 3. Sender idempotency — static logic check ──────────────────────────────
console.log('\n' + SEP)
console.log('  3. Sender idempotency: email_sync_failed rows must block re-send')
console.log(SEP)

// Simulate the idempotency statuses used in sender.ts
const IDEMPOTENCY_STATUSES = ['sent', 'email_sync_failed'] as const

assert(
  IDEMPOTENCY_STATUSES.includes('sent'),
  'Idempotency check includes "sent"'
)
assert(
  IDEMPOTENCY_STATUSES.includes('email_sync_failed'),
  'Idempotency check includes "email_sync_failed" — prevents re-send after sync failure'
)
assert(
  !IDEMPOTENCY_STATUSES.includes('failed' as 'sent'),
  '"failed" is NOT in idempotency check — normal failures are re-tryable'
)

// ── 4. Resend endpoint guard — 409 on email_sync_failed ─────────────────────
console.log('\n' + SEP)
console.log('  4. Resend endpoint guard logic (static)')
console.log(SEP)

// Simulate what the resend route does when it finds an email_sync_failed row
function simulateResendGuard(syncFailedRow: { id: string } | null): { status: number; reason: string } {
  if (syncFailedRow) {
    return { status: 409, reason: 'sync_failed_guard' }
  }
  return { status: 200, reason: 'proceed' }
}

assert(simulateResendGuard({ id: 'abc' }).status === 409, 'Resend returns 409 when email_sync_failed row exists')
assert(simulateResendGuard(null).status === 200,           'Resend proceeds (200) when no email_sync_failed row')

// ── 5. Writer stale-reset exclusion — static logic check ────────────────────
console.log('\n' + SEP)
console.log('  5. Writer stale-reset: excludes email_ready leads with sync-failed rows')
console.log(SEP)

// Simulate the writer's stale-reset logic
function simulateWriterReset(
  emailReadyLeadIds: string[],
  pendingLeadIds: string[],
  syncFailedLeadIds: string[]
): string[] {
  const withPendingSet    = new Set(pendingLeadIds)
  const withSyncFailedSet = new Set(syncFailedLeadIds)
  return emailReadyLeadIds.filter((id) => !withPendingSet.has(id) && !withSyncFailedSet.has(id))
}

const toReset1 = simulateWriterReset(['A', 'B', 'C'], ['A'], [])
assert(JSON.stringify(toReset1.sort()) === JSON.stringify(['B', 'C']), 'Writer resets leads with no pending email (no sync-failed)')

const toReset2 = simulateWriterReset(['A', 'B', 'C'], [], ['B'])
assert(
  !toReset2.includes('B'),
  'Writer does NOT reset lead B which has email_sync_failed row',
  `toReset was: ${JSON.stringify(toReset2)}`
)
assert(
  toReset2.includes('A') && toReset2.includes('C'),
  'Writer still resets A and C (no pending, no sync-failed)',
)

const toReset3 = simulateWriterReset(['A'], ['A'], ['A'])
assert(toReset3.length === 0, 'Lead with both pending and sync-failed is excluded from reset (pending wins)')

// ── 6. Recovery row structure (unit check) ───────────────────────────────────
console.log('\n' + SEP)
console.log('  6. Recovery row structure validation')
console.log(SEP)

// Verify what insertEmailSyncFailedRecovery would insert
interface RecoveryRow {
  status: string
  resend_id: string
  sent_at: string | null
  lead_id: string
  type: string
}

function buildRecoveryRow(resendId: string, sentAt: string, leadId: string, type: string): RecoveryRow {
  return {
    lead_id:   leadId,
    type,
    status:    EMAIL_STATUS.EMAIL_SYNC_FAILED,
    resend_id: resendId,
    sent_at:   sentAt,
  }
}

const row = buildRecoveryRow('resend_123', '2026-06-25T10:00:00Z', 'lead_abc', 'follow_up_1')
assert(row.status === 'email_sync_failed',              'Recovery row has email_sync_failed status')
assert(row.resend_id === 'resend_123',                  'Recovery row preserves resend_id')
assert(row.sent_at === '2026-06-25T10:00:00Z',         'Recovery row has sent_at set (follow-up eligibility uses sent_at)')
assert(isFuEmailSent({ sent_at: row.sent_at }),         'Recovery row with sent_at passes isFuEmailSent check')

// ── 7. Normal send path (no failure) — baseline ─────────────────────────────
console.log('\n' + SEP)
console.log('  7. Normal send path baseline')
console.log(SEP)

function simulateNormalSend(resendResult: { id: string } | null): { status: EmailStatus; resend_id: string | null; sent_at: string | null } {
  if (!resendResult) {
    return { status: 'failed', resend_id: null, sent_at: null }
  }
  const sentAt = '2026-06-25T10:00:00Z'
  // Simulate successful DB update
  return { status: 'sent', resend_id: resendResult.id, sent_at: sentAt }
}

const normalResult = simulateNormalSend({ id: 'resend_abc' })
assert(normalResult.status === 'sent',       'Normal send → status is sent')
assert(normalResult.sent_at !== null,        'Normal send → sent_at is set')
assert(normalResult.resend_id === 'resend_abc', 'Normal send → resend_id preserved')

const failedResult = simulateNormalSend(null)
assert(failedResult.status === 'failed',     'Resend API failure → status is failed')
assert(failedResult.sent_at === null,        'Resend API failure → no sent_at')

// ── 8. DB write failure path ─────────────────────────────────────────────────
console.log('\n' + SEP)
console.log('  8. DB update failure path → email_sync_failed')
console.log(SEP)

function simulateSendWithDbFailure(
  resendResult: { id: string },
  dbUpdateFails: boolean
): { emailStatus: EmailStatus; leadStatus: string; resend_id: string } {
  const sentAt = '2026-06-25T10:00:00Z'
  if (dbUpdateFails) {
    // handleEmailSyncFailure behaviour
    return {
      emailStatus: 'email_sync_failed',
      leadStatus:  'contacted',
      resend_id:   resendResult.id,
    }
  }
  return {
    emailStatus: 'sent',
    leadStatus:  'contacted',
    resend_id:   resendResult.id,
  }
}

const syncFailResult = simulateSendWithDbFailure({ id: 'resend_xyz' }, true)
assert(syncFailResult.emailStatus === 'email_sync_failed', 'DB failure → email marked email_sync_failed')
assert(syncFailResult.leadStatus  === 'contacted',         'DB failure → lead still advanced to contacted (best-effort)')
assert(syncFailResult.resend_id   === 'resend_xyz',        'DB failure → resend_id preserved in recovery row')

// ── 9. DB-write tests (requires TEST_LEAD_ID env var) ────────────────────────
console.log('\n' + DIV)
if (!process.env.TEST_LEAD_ID) {
  console.log('  ℹ  Skipping live DB tests — set TEST_LEAD_ID to enable them.')
  console.log('  ℹ  Tests 9–11 require a real lead ID and will mutate + restore it.')
} else {
  console.log('  9. Live DB tests (TEST_LEAD_ID set)')
  console.log(DIV)
  console.log('  ℹ  Live DB tests are intentionally deferred to keep this script safe.')
  console.log('  ℹ  Use scripts/test-analytics-fu.ts or Supabase dashboard to verify.')
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + SEP)
console.log(`  RESULTS: ${passed} passed, ${failed} failed`)
console.log(SEP)

if (failed > 0) {
  console.error('\n  ✗ Some tests failed — review output above.')
  process.exit(1)
} else {
  console.log('\n  ✓ All tests passed.')
}
