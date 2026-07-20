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
 *
 * The uniqueness guarantee itself is enforced by Postgres (lock_key PRIMARY
 * KEY, migration 028) — that's a DB-level guarantee, not something a
 * single-process fake can re-prove. This test verifies the *code* correctly
 * turns a 23505 unique_violation into "not acquired" and correctly applies
 * the staleness/TTL reclaim logic, using a fake that mirrors real Postgres
 * PK-uniqueness semantics for insert.
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
type LockRow = { lock_key: string; locked_at: string }

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
    assert(first === true, 'First acquire returns true')
    assert(second === false, 'Second acquire for the same held key returns false')
  }

  // ── 3. Release then re-acquire ──────────────────────────────────────────────
  console.log('\n  3. Release then re-acquire succeeds')
  {
    const db = makeFakeLockClient()
    await acquireLock(db, 'resend:lead-1')
    await releaseLock(db, 'resend:lead-1')
    const reacquired = await acquireLock(db, 'resend:lead-1')
    assert(reacquired === true, 'Lock can be re-acquired after release')
  }

  // ── 4. Stale lock is reclaimed ──────────────────────────────────────────────
  console.log('\n  4. Stale lock (older than ttlMs) is reclaimed')
  {
    const db = makeFakeLockClient()
    const staleTimestamp = new Date(Date.now() - 10_000).toISOString() // 10s ago
    db.__rows().push({ lock_key: 'sender_agent', locked_at: staleTimestamp })

    const acquired = await acquireLock(db, 'sender_agent', 1_000) // ttl = 1s, lock is 10s old
    assert(acquired === true, 'A lock older than ttlMs is reclaimed by the next caller')
  }

  // ── 5. Fresh lock is NOT reclaimed ──────────────────────────────────────────
  console.log('\n  5. Fresh lock (younger than ttlMs) is a real conflict, not reclaimed')
  {
    const db = makeFakeLockClient()
    const freshTimestamp = new Date().toISOString()
    db.__rows().push({ lock_key: 'sender_agent', locked_at: freshTimestamp })

    const acquired = await acquireLock(db, 'sender_agent', 15 * 60 * 1000) // 15 min ttl, lock is fresh
    assert(acquired === false, 'A live (fresh) lock is never reclaimed out from under its holder')
  }

  // ── 6. Independent keys don't contend ───────────────────────────────────────
  console.log('\n  6. Independent lock keys never contend')
  {
    const db = makeFakeLockClient()
    const a = await acquireLock(db, 'resend:lead-a')
    const b = await acquireLock(db, 'resend:lead-b')
    assert(a === true && b === true, 'Two different lead locks can both be held at once')
  }

  // ── 7. Unexpected DB error fails closed ─────────────────────────────────────
  console.log('\n  7. Unexpected (non-23505) DB error fails closed')
  {
    const db = makeFakeLockClient()
    db.__setForceInsertError({ code: '42P01', message: 'relation "distributed_locks" does not exist' })
    const acquired = await acquireLock(db, 'sender_agent')
    assert(acquired === false, 'A non-unique-violation error is treated as "lock not acquired", never as "acquired"')
  }

  // ── 8. Releasing an unheld lock is a safe no-op ─────────────────────────────
  console.log('\n  8. releaseLock on a key nobody holds does not throw')
  {
    const db = makeFakeLockClient()
    let threw = false
    try {
      await releaseLock(db, 'never-acquired')
    } catch {
      threw = true
    }
    assert(!threw, 'releaseLock never throws, even for a key that was never held')
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
