/**
 * scripts/test-atomic-quota-enforcement.ts
 *
 * Verifies the fix for Medium audit finding "Atomic quota enforcement":
 * agents/sender.ts's count-then-send quota logic must not be able to run
 * twice concurrently — otherwise two overlapping/retried runs could each
 * compute "remaining quota" from the same stale snapshot and, combined,
 * send more than the configured daily limits.
 *
 *   1. Two "concurrent" attempts to hold the sender's run-level lock — only
 *      one succeeds, proving overlapping runs cannot both proceed past the
 *      quota check at the same time (reuses the real acquireLock()/
 *      releaseLock() against a fake distributed_locks table).
 *   2. Static check: agents/sender.ts acquires the lock (SENDER_LOCK_KEY)
 *      strictly *before* it queries totalSentToday/sentToday, so the lock is
 *      held for the entire "count then send" sequence, not just part of it.
 *   3. Static check: the lock is released in a `finally`, so it's freed on
 *      every exit path (early quota-exhausted return, no-pending-emails
 *      return, normal completion, or a thrown error) — a run that fails
 *      partway can never leave the quota permanently locked.
 *   4. Static check: the counting/slicing logic itself (globalDailyLimit,
 *      dailyLimit, remainingToday, toSend = pendingEmails.slice(...)) is
 *      untouched by this fix — the fix only adds mutual exclusion around the
 *      existing logic, per "preserve existing quota logic and behaviour".
 *
 * Run: npx tsx scripts/test-atomic-quota-enforcement.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { acquireLock, releaseLock } from '../src/lib/distributed-lock'

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

type LockRow = { lock_key: string; locked_at: string; owner_token: string }

function makeFakeLockClient() {
  const rows: LockRow[] = []
  return {
    from(table: string) {
      if (table !== 'distributed_locks') throw new Error(`unexpected table ${table}`)
      let mode: 'insert' | 'delete' = 'insert'
      let insertRow: LockRow | null = null
      const eqFilters: [string, unknown][] = []
      let ltCol: string | null = null
      let ltVal: string | null = null

      const builder = {
        insert(row: LockRow) { mode = 'insert'; insertRow = row; return builder },
        delete() { mode = 'delete'; return builder },
        eq(col: string, val: unknown) { eqFilters.push([col, val]); return builder },
        lt(col: string, val: string) { ltCol = col; ltVal = val; return builder },
        select() { return builder },
        then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
          let result: { data: unknown; error: unknown }
          if (mode === 'insert' && insertRow) {
            if (rows.some((r) => r.lock_key === insertRow!.lock_key)) {
              result = { data: null, error: { code: '23505', message: 'duplicate key' } }
            } else {
              rows.push(insertRow)
              result = { data: [insertRow], error: null }
            }
          } else {
            const matched = rows.filter((r) => {
              const eqOk = eqFilters.every(([col, val]) => (r as Record<string, unknown>)[col] === val)
              const ltOk = ltCol === null || (r as Record<string, unknown>)[ltCol] as string < (ltVal as string)
              return eqOk && ltOk
            })
            for (const m of matched) rows.splice(rows.indexOf(m), 1)
            result = { data: matched, error: null }
          }
          return Promise.resolve(result).then(resolve, reject)
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
      return builder
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

async function main() {
  console.log(SEP)
  console.log('  TEST:ATOMIC-QUOTA-ENFORCEMENT')
  console.log(SEP)

  // ── 1. Overlapping sender runs cannot both hold the lock ───────────────────
  console.log('\n  1. Two overlapping sender runs — only one proceeds past the lock')
  {
    const db = makeFakeLockClient()
    const runA = await acquireLock(db, 'sender_agent')
    const runB = await acquireLock(db, 'sender_agent') // e.g. a retry racing the still-in-flight run
    assert(typeof runA === 'string' && runA.length > 0, 'First run acquires the sender lock')
    assert(runB === null, 'A second, overlapping run is blocked from proceeding to the quota check')

    await releaseLock(db, 'sender_agent', runA!)
    const runC = await acquireLock(db, 'sender_agent')
    assert(typeof runC === 'string' && runC.length > 0, 'Once the first run finishes and releases, the next run can proceed normally')
  }

  const senderSrc = fs.readFileSync(path.resolve(process.cwd(), 'agents/sender.ts'), 'utf8')

  // ── 2. Lock acquired before quota counting begins ──────────────────────────
  console.log('\n  2. Lock is acquired before totalSentToday/sentToday are counted')
  {
    const lockIdx = senderSrc.indexOf('acquireLock(supabase, SENDER_LOCK_KEY)')
    const countIdx = senderSrc.indexOf('totalSentToday')
    assert(lockIdx !== -1, 'agents/sender.ts calls acquireLock(supabase, SENDER_LOCK_KEY)')
    assert(countIdx !== -1, 'agents/sender.ts still counts totalSentToday')
    assert(lockIdx < countIdx, 'The lock is acquired strictly before the quota count query runs')
  }

  // ── 3. Lock released in a finally covering every exit path ─────────────────
  console.log('\n  3. Lock is released in a finally block')
  {
    const releaseInFinally = /}\s*finally\s*{\s*await releaseLock\(supabase, SENDER_LOCK_KEY, lockToken\)\s*}/.test(senderSrc)
    assert(releaseInFinally, 'agents/sender.ts releases SENDER_LOCK_KEY inside a finally block using its own acquired token', releaseInFinally ? undefined : 'pattern not found')

    // Every early return between the lock acquisition and the finally must be
    // inside the try that the finally is attached to (i.e. before it in the file).
    const lockIdx = senderSrc.indexOf('acquireLock(supabase, SENDER_LOCK_KEY)')
    const finallyIdx = senderSrc.indexOf('} finally {')
    const earlyReturnIdx = senderSrc.indexOf("'daily_initial_outreach_limit_reached'")
    assert(
      earlyReturnIdx > lockIdx && earlyReturnIdx < finallyIdx,
      'The quota-exhausted early return is inside the locked region, so it still releases via finally'
    )
  }

  // ── 4. Existing quota logic is untouched ────────────────────────────────────
  console.log('\n  4. Existing quota counting/slicing logic is preserved')
  {
    assert(senderSrc.includes("parseInt(globalLimitRow.data?.value ?? '100', 10)"), 'globalDailyLimit default (100) unchanged')
    assert(senderSrc.includes("parseInt(limitRow.data?.value ?? '50', 10)"), 'dailyLimit default (50) unchanged')
    assert(senderSrc.includes('Math.max(0, globalDailyLimit - (totalSentToday ?? 0))'), 'globalRemaining calculation unchanged')
    assert(senderSrc.includes('Math.max(0, dailyLimit - (sentToday ?? 0))'), 'initialRemaining calculation unchanged')
    assert(senderSrc.includes('Math.min(globalRemaining, initialRemaining)'), 'remainingToday = min(global, initial) unchanged')
    assert(senderSrc.includes('pendingEmails.slice(0, remainingToday)'), 'hard cap slice unchanged')
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
