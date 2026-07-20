/**
 * scripts/test-duplicate-followup-prevention.ts
 *
 * Verifies the fix for overlapping/concurrent scheduler runs double-sending
 * follow-ups (High audit finding):
 *   1. sendFollowUp's pre-send idempotency re-check skips a lead+type that
 *      was already delivered — real call against agents/followup.ts with a
 *      fake Supabase client (Claude/Resend are stubbed and MUST NOT be
 *      called on the skip path, since the whole point is to avoid work when
 *      a concurrent run already handled this lead)
 *   2. If the idempotency check still loses the race (TOCTOU: another run
 *      inserts between our check and our insert), the unique_violation
 *      (Postgres code 23505) from the emails_lead_type_delivered_key index
 *      is handled gracefully — logged, not thrown, no double-counted send
 *   3. Simulates two concurrent runs racing to insert a delivered row for
 *      the same (lead_id, type) against the same uniqueness rule the DB
 *      index enforces (migration 027) — only one may win
 *   4. Static check that the Trigger.dev schedule has concurrencyLimit: 1,
 *      the scheduler-level defense against overlapping runs in the first
 *      place
 *
 * Run: npx tsx scripts/test-duplicate-followup-prevention.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { sendFollowUp } from '../agents/followup'

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

// ─── Minimal fake Supabase — same shape as scripts/test-webhook-handling.ts,
// extended with .in() (used by the idempotency pre-check) and an optional
// unique-constraint simulation on insert (used by test 2/3 below).
type Row = Record<string, unknown>

function makeFakeSupabase(
  tables: Record<string, Row[]>,
  opts: { enforceUniqueDeliveredPerLeadType?: boolean } = {}
) {
  return {
    from(table: string) {
      const eqFilters: [string, unknown][] = []
      const inFilters: [string, unknown[]][] = []
      let limitN: number | undefined
      let mode: 'select' | 'update' | 'insert' = 'select'
      let insertRow: Row = {}

      const rowsFor = () => (tables[table] ??= [])

      const applyFilters = (list: Row[]) => {
        let out = list
        for (const [col, val] of eqFilters) out = out.filter((r) => r[col] === val)
        for (const [col, vals] of inFilters) out = out.filter((r) => vals.includes(r[col]))
        if (limitN !== undefined) out = out.slice(0, limitN)
        return out
      }

      const builder = {
        eq(col: string, val: unknown) { eqFilters.push([col, val]); return builder },
        in(col: string, vals: unknown[]) { inFilters.push([col, vals]); return builder },
        limit(n: number) { limitN = n; return builder },
        select() { if (mode !== 'insert') mode = 'select'; return builder },
        insert(row: Row) {
          mode = 'insert'
          insertRow = row
          return builder
        },
        async single() {
          if (mode === 'insert') {
            if (
              opts.enforceUniqueDeliveredPerLeadType &&
              (insertRow.status === 'sent' || insertRow.status === 'email_sync_failed')
            ) {
              const conflict = rowsFor().some(
                (r) =>
                  r.lead_id === insertRow.lead_id &&
                  r.type === insertRow.type &&
                  (r.status === 'sent' || r.status === 'email_sync_failed')
              )
              if (conflict) {
                return {
                  data: null,
                  error: { code: '23505', message: 'duplicate key value violates unique constraint "emails_lead_type_delivered_key"' },
                }
              }
            }
            const inserted = { id: `generated-${rowsFor().length}`, ...insertRow }
            rowsFor().push(inserted)
            return { data: inserted, error: null }
          }
          const matched = applyFilters(rowsFor())
          return matched.length === 1 ? { data: matched[0], error: null } : { data: null, error: { message: 'no rows' } }
        },
        then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
          const matched = applyFilters(rowsFor())
          return Promise.resolve({ data: matched, error: null }).then(resolve, reject)
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
      return builder
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function makeCandidate(leadId: string) {
  return {
    lead: {
      id: leadId, business_name: 'Test Biz', email: 'biz@example.com',
      category_name: 'Nail Salons', content_type: 'remote', suburb: 'Bondi', city: 'Sydney',
      website: '', description: '', services: '', notes: '', emails: [],
    },
    initialEmail: { id: 'initial-1', type: 'initial_pitch', subject: 'Collab?', body_text: '', sent_at: '2026-01-01T00:00:00Z', status: 'sent', message_id: '<initial@aussieventure.com>' },
    daysSince: 10,
  }
}

const stubAiGenerator = async () => ({ subject: 'Re: Collab?', body: 'stub body' })

console.log(SEP)
console.log('  TEST:DUPLICATE-FOLLOWUP-PREVENTION')
console.log(SEP)

async function main() {
  // ── 1. Fresh lead — send proceeds normally ──────────────────────────────────
  console.log('\n  1. No prior delivered row — send proceeds')
  {
    const db = makeFakeSupabase({ emails: [], follow_ups: [], activity_log: [] }, { enforceUniqueDeliveredPerLeadType: true })
    let sendCalls = 0
    const stubSendEmail = async () => { sendCalls++; return { id: 'rs_1', messageId: '<fu1@aussieventure.com>' } }

    const result = await sendFollowUp(db, makeCandidate('lead-1'), 'follow_up_1', stubAiGenerator as never, stubSendEmail as never)
    assert(result === true, 'sendFollowUp returns true on a normal send')
    assert(sendCalls === 1, 'Email is sent exactly once')
  }

  // ── 2. Idempotency skip: already delivered — sendEmail must NOT be called ──
  console.log('\n  2. Already-delivered row for this lead+type — skipped before any send')
  {
    const db = makeFakeSupabase(
      { emails: [{ id: 'e1', lead_id: 'lead-2', type: 'follow_up_1', status: 'sent' }], follow_ups: [], activity_log: [] },
      { enforceUniqueDeliveredPerLeadType: true }
    )
    let sendCalls = 0
    let aiCalls = 0
    const stubSendEmail = async () => { sendCalls++; return { id: 'rs_x', messageId: '<x@aussieventure.com>' } }
    const countingAi = async () => { aiCalls++; return { subject: 'Re: Collab?', body: 'x' } }

    const result = await sendFollowUp(db, makeCandidate('lead-2'), 'follow_up_1', countingAi as never, stubSendEmail as never)
    assert(result === false, 'sendFollowUp returns false (skip) when already delivered')
    assert(sendCalls === 0, 'Resend is never called for an already-delivered lead+type (no duplicate email)')
    assert(aiCalls === 0, 'Claude is never called either — the skip happens before any generation work')
  }

  // ── 3. Idempotency skip also covers email_sync_failed (delivered, DB-lagging) ──
  console.log('\n  3. email_sync_failed also counts as "already delivered"')
  {
    const db = makeFakeSupabase(
      { emails: [{ id: 'e1', lead_id: 'lead-3', type: 'follow_up_2', status: 'email_sync_failed' }], follow_ups: [], activity_log: [] },
      { enforceUniqueDeliveredPerLeadType: true }
    )
    let sendCalls = 0
    const stubSendEmail = async () => { sendCalls++; return { id: 'rs_x', messageId: '<x@aussieventure.com>' } }
    const result = await sendFollowUp(db, makeCandidate('lead-3'), 'follow_up_2', stubAiGenerator as never, stubSendEmail as never)
    assert(result === false, 'email_sync_failed (delivered-but-DB-lagging) also blocks a duplicate send')
    assert(sendCalls === 0, 'Resend is not called')
  }

  // ── 4. Lost the race: DB unique constraint catches a TOCTOU duplicate ──────
  console.log('\n  4. Idempotency check race lost — DB unique constraint is the backstop')
  {
    // sendFollowUp's own pre-check sees an empty table (so it proceeds) —
    // but the instant that check resolves, a concurrent run's insert lands
    // for the same lead+type, before our own insert executes. This models
    // two overlapping scheduler runs racing on the exact same candidate and
    // losing the TOCTOU window between the check and the insert.
    const tables: Record<string, Row[]> = { emails: [], follow_ups: [], activity_log: [] }
    let selectCallCount = 0

    const db = {
      from(table: string) {
        const eqFilters: [string, unknown][] = []
        const inFilters: [string, unknown[]][] = []
        let limitN: number | undefined
        let mode: 'select' | 'insert' = 'select'
        let insertRow: Row = {}

        const applyFilters = (list: Row[]) => {
          let out = list
          for (const [col, val] of eqFilters) out = out.filter((r) => r[col] === val)
          for (const [col, vals] of inFilters) out = out.filter((r) => vals.includes(r[col]))
          if (limitN !== undefined) out = out.slice(0, limitN)
          return out
        }

        const builder = {
          eq(col: string, val: unknown) { eqFilters.push([col, val]); return builder },
          in(col: string, vals: unknown[]) { inFilters.push([col, vals]); return builder },
          limit(n: number) { limitN = n; return builder },
          select() { if (mode !== 'insert') mode = 'select'; return builder },
          insert(row: Row) { mode = 'insert'; insertRow = row; return builder },
          async single() {
            if (mode === 'insert') {
              const conflict = tables.emails.some(
                (r) =>
                  r.lead_id === insertRow.lead_id &&
                  r.type === insertRow.type &&
                  (r.status === 'sent' || r.status === 'email_sync_failed')
              )
              if (conflict) {
                return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "emails_lead_type_delivered_key"' } }
              }
              const inserted = { id: 'new-row', ...insertRow }
              tables.emails.push(inserted)
              return { data: inserted, error: null }
            }
            return { data: null, error: { message: 'no rows' } }
          },
          then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
            const matched = applyFilters(tables[table] ?? [])
            if (table === 'emails' && mode === 'select') {
              selectCallCount++
              if (selectCallCount === 1) {
                // Concurrent run's delivery lands right after our check read its snapshot.
                tables.emails.push({ id: 'concurrent-row', lead_id: 'lead-4', type: 'follow_up_1', status: 'sent' })
              }
            }
            return Promise.resolve({ data: matched, error: null }).then(resolve, reject)
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any
        return builder
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    const stubSendEmail = async () => ({ id: 'rs_race', messageId: '<race@aussieventure.com>' })

    let threw = false
    let result: boolean | undefined
    try {
      result = await sendFollowUp(db, makeCandidate('lead-4'), 'follow_up_1', stubAiGenerator as never, stubSendEmail as never)
    } catch {
      threw = true
    }
    assert(!threw, 'A lost idempotency race does not throw or crash the run')
    assert(result === false, 'A lost idempotency race is treated as a skip, not a second successful send')
  }

  // ── 5. Concurrent inserts against the same uniqueness rule — only one wins ──
  console.log('\n  5. Simulated concurrent inserts — DB constraint allows only one delivered row')
  {
    const delivered: Row[] = []
    function tryInsert(leadId: string, type: string): { ok: boolean; code?: string } {
      const conflict = delivered.some((r) => r.lead_id === leadId && r.type === type)
      if (conflict) return { ok: false, code: '23505' }
      delivered.push({ lead_id: leadId, type, status: 'sent' })
      return { ok: true }
    }

    // Two "concurrent" runs both attempt to record FU1 as sent for the same lead.
    const first = tryInsert('lead-5', 'follow_up_1')
    const second = tryInsert('lead-5', 'follow_up_1')

    assert(first.ok === true, 'First concurrent insert succeeds')
    assert(second.ok === false && second.code === '23505', 'Second concurrent insert for the same lead+type is rejected by the unique constraint', JSON.stringify(second))
    assert(delivered.length === 1, 'Exactly one delivered row exists for this lead+type after the race')
  }

  // ── 6. Static check: scheduler-level concurrency limit is configured ───────
  console.log('\n  6. Trigger.dev schedule has concurrencyLimit: 1')
  {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'trigger/daily-pipeline.ts'), 'utf8')
    const hasQueue = /queue:\s*\{\s*concurrencyLimit:\s*1/.test(src)
    assert(hasQueue, 'trigger/daily-pipeline.ts declares queue: { concurrencyLimit: 1 } on dailyPipelineJob', hasQueue ? undefined : 'pattern not found in source')
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
}

main()
