/**
 * scripts/test-distributed-lock.ts
 *
 * Verifies src/lib/distributed-lock.ts (Medium audit fix: atomic quota
 * enforcement + duplicate-resend protection, both built on this primitive):
 *   1. First acquire succeeds
 *   2. A second acquire for the same key, while the first is still held,
 *      fails (models two concurrent callers racing the same lock)
 *   3. After release, the same key can be acquired again
 *   4. A stale lock (older than ttlMs) is reclaimed automatically
 *   5. A fresh lock (younger than ttlMs) is NOT reclaimed — a live holder is
 *      a real conflict, not a crash
 *   6. Two independent keys never contend with each other
 *   7. Unexpected (non-23505) DB errors fail closed (lock not acquired)
 *   8. releaseLock on a key nobody holds is a safe no-op
 *   9. Fencing: if a lock is reclaimed as stale while the original holder is
 *      still alive, the original holder's later releaseLock() (with its now
 *      stale token) must NOT delete the new holder's lock — this is the
 *      production-readiness-audit fix (owner_token column, migration 029).
 *
 * The uniqueness guarantee itself is enforced by Postgres (lock_key PRIMARY
 * KEY, migration 028) — that's a DB-level guarantee, not something a
 * single-process fake can re-prove. This test verifies the *code* correctly
 * turns a 23505 unique_violation into "not acquired" and correctly applies
 * the staleness/TTL reclaim logic and owner-token fencing, using a fake that
 * mirrors real Postgres PK-uniqueness semantics for insert.
 *
 * Run: npx tsx scripts/test-distributed-lock.ts
 */

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

// ─── Fake `distributed_locks` table — PRIMARY KEY(lock_key) semantics on
// insert (second insert for an existing key returns 23505), plus delete with
// .eq().lt().select() returning the rows actually removed (mirrors Postgres
// returning 0 rows when the WHERE clause matches nothing).
type LockRow = { lock_key: string; locked_at: string; owner_token: string }

function makeFakeLockClient() {
  let rows: LockRow[] = []
  let forceInsertError: { code: string; message: string } | null = null

  return {
    __setForceInsertError(err: { code: string; message: string } | null) { forceInsertError = err },
    __rows() { return rows },
    from(table: string) {
      if (table !== 'distributed_locks') throw new Error(`unexpected table ${table}`)

      let mode: 'insert' | 'delete' = 'insert'
      let insertRow: LockRow | null = null
      const eqFilters: [string, unknown][] = []
      let ltCol: string | null = null
      let ltVal: string | null = null

      const builder = {
        insert(row: LockRow) {
          mode = 'insert'
          insertRow = row
          // supabase-js resolves a bare `.insert(...)` await directly (no .select()),
          // so this must itself be thenable.
          return builder
        },
        delete() { mode = 'delete'; return builder },
        eq(col: string, val: unknown) { eqFilters.push([col, val]); return builder },
        lt(col: string, val: string) { ltCol = col; ltVal = val; return builder },
        select() { return builder },
        then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
          let result: { data: unknown; error: unknown }

          if (mode === 'insert' && insertRow) {
            if (forceInsertError) {
              result = { data: null, error: forceInsertError }
            } else if (rows.some((r) => r.lock_key === insertRow!.lock_key)) {
              result = { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "distributed_locks_pkey"' } }
            } else {
              rows.push(insertRow)
              result = { data: [insertRow], error: null }
            }
          } else if (mode === 'delete') {
            const matched = rows.filter((r) => {
              const eqOk = eqFilters.every(([col, val]) => (r as Record<string, unknown>)[col] === val)
              const ltOk = ltCol === null || (r as Record<string, unknown>)[ltCol] as string < (ltVal as string)
              return eqOk && ltOk
            })
            rows = rows.filter((r) => !matched.includes(r))
            result = { data: matched, error: null }
          } else {
            result = { data: null, error: { message: 'unhandled fake mode' } }
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
  console.log('  TEST:DISTRIBUTED-LOCK')
  console.log(SEP)

  // ── 1 & 2. First acquire succeeds, concurrent second acquire fails ─────────
  console.log('\n  1-2. First acquire succeeds; concurrent second acquire for the same key fails')
  {
    const db = makeFakeLockClient()
    const first = await acquireLock(db, 'sender_agent')
    const second = await acquireLock(db, 'sender_agent')
    assert(typeof first === 'string' && first.length > 0, 'First acquire returns a non-empty token')
    assert(second === null, 'Second acquire for the same held key returns null')
  }

  // ── 3. Release then re-acquire ──────────────────────────────────────────────
  console.log('\n  3. Release then re-acquire succeeds')
  {
    const db = makeFakeLockClient()
    const token = await acquireLock(db, 'resend:lead-1')
    await releaseLock(db, 'resend:lead-1', token!)
    const reacquired = await acquireLock(db, 'resend:lead-1')
    assert(typeof reacquired === 'string' && reacquired.length > 0, 'Lock can be re-acquired after release')
  }

  // ── 4. Stale lock is reclaimed ──────────────────────────────────────────────
  console.log('\n  4. Stale lock (older than ttlMs) is reclaimed')
  {
    const db = makeFakeLockClient()
    const staleTimestamp = new Date(Date.now() - 10_000).toISOString() // 10s ago
    db.__rows().push({ lock_key: 'sender_agent', locked_at: staleTimestamp, owner_token: 'old-holder-token' })

    const acquired = await acquireLock(db, 'sender_agent', 1_000) // ttl = 1s, lock is 10s old
    assert(typeof acquired === 'string' && acquired.length > 0, 'A lock older than ttlMs is reclaimed by the next caller')
  }

  // ── 5. Fresh lock is NOT reclaimed ──────────────────────────────────────────
  console.log('\n  5. Fresh lock (younger than ttlMs) is a real conflict, not reclaimed')
  {
    const db = makeFakeLockClient()
    const freshTimestamp = new Date().toISOString()
    db.__rows().push({ lock_key: 'sender_agent', locked_at: freshTimestamp, owner_token: 'live-holder-token' })

    const acquired = await acquireLock(db, 'sender_agent', 15 * 60 * 1000) // 15 min ttl, lock is fresh
    assert(acquired === null, 'A live (fresh) lock is never reclaimed out from under its holder')
  }

  // ── 6. Independent keys don't contend ───────────────────────────────────────
  console.log('\n  6. Independent lock keys never contend')
  {
    const db = makeFakeLockClient()
    const a = await acquireLock(db, 'resend:lead-a')
    const b = await acquireLock(db, 'resend:lead-b')
    assert(!!a && !!b, 'Two different lead locks can both be held at once')
  }

  // ── 7. Unexpected DB error fails closed ─────────────────────────────────────
  console.log('\n  7. Unexpected (non-23505) DB error fails closed')
  {
    const db = makeFakeLockClient()
    db.__setForceInsertError({ code: '42P01', message: 'relation "distributed_locks" does not exist' })
    const acquired = await acquireLock(db, 'sender_agent')
    assert(acquired === null, 'A non-unique-violation error is treated as "lock not acquired", never as "acquired"')
  }

  // ── 8. Releasing an unheld lock is a safe no-op ─────────────────────────────
  console.log('\n  8. releaseLock on a key nobody holds does not throw')
  {
    const db = makeFakeLockClient()
    let threw = false
    try {
      await releaseLock(db, 'never-acquired', 'some-token')
    } catch {
      threw = true
    }
    assert(!threw, 'releaseLock never throws, even for a key that was never held')
  }

  // ── 9. Fencing: a reclaimed lock survives its original holder's release ────
  console.log('\n  9. Fencing: original holder cannot release a lock reclaimed out from under it')
  {
    const db = makeFakeLockClient()

    // Holder A acquires, but its lock immediately becomes "stale" from B's
    // point of view (simulating A running long past the TTL while still
    // legitimately alive and working).
    const staleTimestamp = new Date(Date.now() - 10_000).toISOString()
    db.__rows().push({ lock_key: 'sender_agent', locked_at: staleTimestamp, owner_token: 'holder-A-token' })
    const tokenA = 'holder-A-token'

    // Holder B reclaims the stale lock and gets its own token.
    const tokenB = await acquireLock(db, 'sender_agent', 1_000)
    assert(!!tokenB && tokenB !== tokenA, 'Holder B reclaims the stale lock with a fresh token')

    // Holder A, unaware it was reclaimed, now finishes its (legitimately
    // long-running) work and calls releaseLock with its OWN (stale) token.
    await releaseLock(db, 'sender_agent', tokenA)

    const stillHeld = db.__rows().some((r: LockRow) => r.lock_key === 'sender_agent' && r.owner_token === tokenB)
    assert(stillHeld, "Holder A's release does not delete holder B's active lock")

    // A third caller must therefore still be blocked — B genuinely holds it.
    const tokenC = await acquireLock(db, 'sender_agent', 15 * 60 * 1000)
    assert(tokenC === null, 'A third caller is still correctly blocked while B holds the lock')
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
