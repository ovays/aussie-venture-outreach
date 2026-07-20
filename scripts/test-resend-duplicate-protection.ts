/**
 * scripts/test-resend-duplicate-protection.ts
 *
 * Verifies the fix for Medium audit finding "Duplicate protection for manual
 * resend": src/app/api/leads/[id]/resend/route.ts must not be able to send
 * twice for the same lead if the endpoint is hit twice (double-click,
 * client retry) or concurrently.
 *
 *   1. Two "concurrent" resend requests for the same lead — only the first
 *      acquires the per-lead lock; the second must be rejected before doing
 *      any work (no AI generation, no Resend API call, no email record).
 *   2. A resend for a *different* lead is never blocked by another lead's
 *      in-flight resend.
 *   3. Static check: the lock is acquired before the email_sync_failed /
 *      pending-draft checks (i.e. before any read that feeds a decision to
 *      send), so the whole check-then-send sequence is inside the lock.
 *   4. Static check: a failed acquire returns HTTP 409 with an explanatory
 *      message, not a silent success or a 5xx.
 *   5. Static check: the lock is released in a finally, so a genuine failure
 *      (AI error, Resend error, DB error) doesn't leave the lead permanently
 *      un-resendable — the next legitimate attempt can still proceed.
 *
 * Run: npx tsx scripts/test-resend-duplicate-protection.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { acquireLock } from '../src/lib/distributed-lock'

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
  console.log('  TEST:RESEND-DUPLICATE-PROTECTION')
  console.log(SEP)

  // ── 1. Concurrent resend requests for the same lead ─────────────────────────
  console.log('\n  1. Two concurrent resend requests for the same lead — only one proceeds')
  {
    const db = makeFakeLockClient()
    const leadId = 'lead-123'

    let aiCalls = 0
    let resendCalls = 0

    async function simulateRequest(): Promise<{ status: number }> {
      const token = await acquireLock(db, `resend:${leadId}`, 3 * 60 * 1000)
      if (!token) return { status: 409 }
      aiCalls++
      resendCalls++
      return { status: 200 }
    }

    const [first, second] = await Promise.all([simulateRequest(), simulateRequest()])
    const statuses = [first.status, second.status].sort()

    assert(JSON.stringify(statuses) === JSON.stringify([200, 409]), 'Exactly one request succeeds (200) and the other is rejected (409)', JSON.stringify(statuses))
    assert(aiCalls === 1, 'AI generation only runs once for the pair of requests')
    assert(resendCalls === 1, 'The Resend API is only called once for the pair of requests — no duplicate outbound email')
  }

  // ── 2. Different leads never block each other ───────────────────────────────
  console.log('\n  2. Resend for a different lead is unaffected by another lead\'s in-flight resend')
  {
    const db = makeFakeLockClient()
    const gotA = await acquireLock(db, 'resend:lead-a')
    const gotB = await acquireLock(db, 'resend:lead-b')
    assert(!!gotA && !!gotB, 'Locks are scoped per-lead, not global')
  }

  const routeSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/app/api/leads/[id]/resend/route.ts'),
    'utf8'
  )

  // ── 3. Lock acquired before any read that feeds the send decision ──────────
  console.log('\n  3. Lock is acquired before the email_sync_failed / pending-draft checks')
  {
    const lockIdx = routeSrc.indexOf("acquireLock(supabase, lockKey, RESEND_LOCK_TTL_MS)")
    const syncFailedIdx = routeSrc.indexOf("eq('status', 'email_sync_failed')")
    const sendIdx = routeSrc.indexOf('await sendEmail({')
    assert(lockIdx !== -1, 'route.ts calls acquireLock(supabase, lockKey, RESEND_LOCK_TTL_MS)')
    assert(lockIdx < syncFailedIdx, 'Lock is acquired before the email_sync_failed guard read')
    assert(lockIdx < sendIdx, 'Lock is acquired before sendEmail() is ever called')
  }

  // ── 4. Failed acquire returns 409 with a clear message ──────────────────────
  console.log('\n  4. A failed lock acquisition returns HTTP 409')
  {
    const has409 = /if \(!lockToken\) \{\s*return NextResponse\.json\(\s*\{ error: '[^']+' \},\s*\{ status: 409 \}/.test(routeSrc)
    assert(has409, 'route.ts returns { status: 409 } with an explanatory error when the lock is already held', has409 ? undefined : 'pattern not found')
  }

  // ── 5. Lock released in a finally, fenced to this request's own token ──────
  console.log('\n  5. Lock is released in a finally block, fenced to this request\'s own token')
  {
    const releaseInFinally = /}\s*finally\s*{\s*await releaseLock\(supabase, lockKey, lockToken\)\s*}/.test(routeSrc)
    assert(releaseInFinally, 'route.ts releases the per-lead lock inside a finally block using its own acquired token', releaseInFinally ? undefined : 'pattern not found')
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
