/**
 * scripts/test-bulk-send-duplicate-protection.ts
 *
 * Verifies the production-readiness-audit fix for src/app/api/leads/bulk/
 * route.ts's `send_initial_emails` action: unlike agents/sender.ts (which
 * checks for an already-sent row before sending) and unlike
 * src/app/api/leads/[id]/resend/route.ts (which takes a per-lead distributed
 * lock around its whole check-then-send sequence), the bulk-send action had
 * neither — so it could race the automated sender agent or a concurrent
 * bulk/manual-resend request for the same lead and deliver a real duplicate
 * email, with no DB-level backstop in the common case (it UPDATEs an
 * existing pending_send row rather than INSERTing, so migration 027's
 * unique index — which only guards INSERTs — never catches it).
 *
 * The fix adds the same `resend:<lead_id>` per-lead lock used by the manual
 * resend route, plus an idempotency re-check (status in sent/
 * email_sync_failed) performed under that lock, immediately before sending.
 *
 * This is a static source check (consistent with this repo's existing
 * convention — see scripts/test-resend-duplicate-protection.ts) since this
 * route handler calls the real Supabase/Resend/Claude clients directly with
 * no injection seam for a full dynamic run.
 *
 * Run: npx tsx scripts/test-bulk-send-duplicate-protection.ts
 */

import * as fs from 'fs'
import * as path from 'path'

const SEP = '═'.repeat(60)
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

async function main() {
  console.log(SEP)
  console.log('  TEST:BULK-SEND-DUPLICATE-PROTECTION')
  console.log(SEP)

  const src = fs.readFileSync(path.resolve(process.cwd(), 'src/app/api/leads/bulk/route.ts'), 'utf8')

  console.log('\n  1. Lock is acquired per-lead, before the idempotency check or send')
  {
    const actionIdx = src.indexOf("if (action === 'send_initial_emails')")
    const lockIdx = src.indexOf("acquireLock(supabase, lockKey, BULK_SEND_LOCK_TTL_MS)", actionIdx)
    const alreadySentIdx = src.indexOf("in('status', ['sent', 'email_sync_failed'])", actionIdx)
    const sendIdx = src.indexOf('await sendEmail({', actionIdx)

    assert(actionIdx !== -1, "The send_initial_emails action still exists")
    assert(lockIdx !== -1, "bulk/route.ts acquires a per-lead lock via acquireLock(supabase, lockKey, BULK_SEND_LOCK_TTL_MS)")
    assert(alreadySentIdx !== -1 && alreadySentIdx > lockIdx, "The idempotency re-check (sent/email_sync_failed) runs after the lock is acquired")
    assert(sendIdx !== -1 && sendIdx > alreadySentIdx, "sendEmail() is only reached after both the lock and the idempotency check pass")
  }

  console.log('\n  2. A failed lock acquisition skips the lead instead of sending')
  {
    const hasSkip = /if \(!lockToken\) \{\s*failed\.push/.test(src)
    assert(hasSkip, "bulk/route.ts pushes a 'failed' entry and skips the lead when the lock is already held", hasSkip ? undefined : 'pattern not found')
  }

  console.log('\n  3. Lock is released in a finally block covering every exit path')
  {
    const releaseInFinally = /}\s*finally\s*{\s*await releaseLock\(supabase, lockKey, lockToken\)\s*}/.test(src)
    assert(releaseInFinally, 'bulk/route.ts releases the per-lead lock inside a finally block using its own acquired token', releaseInFinally ? undefined : 'pattern not found')
  }

  console.log('\n  4. The recovery-row insert error is no longer silently discarded')
  {
    const recoveryIdx = src.indexOf("status: 'email_sync_failed', resend_id: result.id")
    assert(recoveryIdx !== -1, 'The recovery-row insert for a delivered-but-unrecorded email still exists')
    const nearbyBody = src.slice(recoveryIdx, recoveryIdx + 400)
    assert(/recoveryErr/.test(nearbyBody), 'The recovery insert error is captured (recoveryErr) rather than discarded')
    assert(/logger\.error\(/.test(nearbyBody), 'A discarded recovery-insert failure is now logged so a fully-untracked duplicate delivery is not silent')
  }

  console.log('\n' + SEP)
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`)
  console.log(SEP)

  if (failed > 0) {
    console.error('\n  ✗ Some tests failed — review output above.')
    process.exit(1)
  } else {
    console.log('\n  ✓ All tests passed.')
  }
}

main()
