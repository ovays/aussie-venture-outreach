/**
 * scripts/test-webhook-handling.ts
 *
 * Verifies agents/tracker.ts's webhook-driven handlers against an in-memory
 * fake Supabase client (no live DB, no network) — covers:
 *   - Bounce handling matches emails.resend_id (fixes the Critical bug where
 *     the old code matched emails.id against Resend's external id and so
 *     never actually updated any row)
 *   - Reply handling advances 'contacted' -> 'replied' but does not regress
 *     a lead already past that stage
 *   - Duplicate webhook delivery (Resend redelivers "at least once") is safe
 *     to replay for both bounce and reply handling
 *   - Inbound reply matching (email.received) via In-Reply-To header lookup,
 *     with a from-address fallback when no header match is found
 *
 * Run: npx tsx scripts/test-webhook-handling.ts
 */

import { handleEmailBounce, handleEmailReply, handleInboundEmail } from '../agents/tracker'

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

// ─── Minimal in-memory fake of the Supabase query-builder surface actually
// used by agents/tracker.ts: .from(table).select/update/insert().eq/ilike/limit()
// then either .single()/.maybeSingle() or awaited directly. Not a general
// Postgrest mock — just enough to exercise the real handler logic.
type Row = Record<string, unknown>

function makeFakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const eqFilters: [string, unknown][] = []
      const ilikeFilters: [string, unknown][] = []
      let limitN: number | undefined
      let mode: 'select' | 'update' | null = null
      let patch: Row = {}

      const rowsFor = () => (tables[table] ??= [])

      const applyFilters = (list: Row[]) => {
        let out = list
        for (const [col, val] of eqFilters) out = out.filter((r) => r[col] === val)
        for (const [col, val] of ilikeFilters) {
          out = out.filter((r) => typeof r[col] === 'string' && (r[col] as string).toLowerCase() === String(val).toLowerCase())
        }
        if (limitN !== undefined) out = out.slice(0, limitN)
        return out
      }

      const exec = async () => {
        const matched = applyFilters(rowsFor())
        if (mode === 'update') {
          for (const row of matched) Object.assign(row, patch)
          return { data: null, error: null }
        }
        return { data: matched, error: null }
      }

      const builder = {
        eq(col: string, val: unknown) { eqFilters.push([col, val]); return builder },
        ilike(col: string, val: unknown) { ilikeFilters.push([col, val]); return builder },
        limit(n: number) { limitN = n; return builder },
        select() { mode = 'select'; return builder },
        update(p: Row) { mode = 'update'; patch = p; return builder },
        insert(row: Row) {
          rowsFor().push({ id: `generated-${rowsFor().length}`, ...row })
          return Promise.resolve({ data: null, error: null })
        },
        async single() {
          const matched = applyFilters(rowsFor())
          if (matched.length !== 1) return { data: null, error: { message: 'no rows' } }
          return { data: matched[0], error: null }
        },
        async maybeSingle() {
          const matched = applyFilters(rowsFor())
          return { data: matched[0] ?? null, error: null }
        },
        then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
          return exec().then(resolve, reject)
        },
      }
      return builder
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

console.log(SEP)
console.log('  TEST:WEBHOOK-HANDLING')
console.log(SEP)

async function main() {
  // ── 1. Bounce handling matches resend_id, not internal id ──────────────────
  console.log('\n  1. Bounce handling — matches emails.resend_id')
  {
    const db = makeFakeSupabase({
      emails: [{ id: 'row-1', lead_id: 'lead-1', resend_id: 'rs_123', status: 'sent' }],
      activity_log: [],
    })
    await handleEmailBounce('lead-1', 'rs_123', db)
    const check = await db.from('emails').select().eq('id', 'row-1').maybeSingle()
    assert(check.data?.status === 'bounced', 'Row with matching resend_id is marked bounced', JSON.stringify(check.data))
  }

  // ── 2. Bounce handling does not touch a row with a different resend_id ────
  console.log('\n  2. Bounce handling — non-matching resend_id is untouched')
  {
    const db = makeFakeSupabase({
      emails: [{ id: 'row-1', lead_id: 'lead-1', resend_id: 'rs_123', status: 'sent' }],
      activity_log: [],
    })
    await handleEmailBounce('lead-1', 'rs_DIFFERENT', db)
    const check = await db.from('emails').select().eq('id', 'row-1').maybeSingle()
    assert(check.data?.status === 'sent', 'Row with a different resend_id is left unchanged (no false-positive match)', JSON.stringify(check.data))
  }

  // ── 3. Duplicate bounce delivery is idempotent ──────────────────────────────
  console.log('\n  3. Duplicate webhook delivery — bounce replay is idempotent')
  {
    const db = makeFakeSupabase({
      emails: [{ id: 'row-1', lead_id: 'lead-1', resend_id: 'rs_123', status: 'sent' }],
      activity_log: [],
    })
    await handleEmailBounce('lead-1', 'rs_123', db)
    await handleEmailBounce('lead-1', 'rs_123', db) // redelivered
    const check = await db.from('emails').select().eq('id', 'row-1').maybeSingle()
    assert(check.data?.status === 'bounced', 'Row is still (only) bounced after redelivery', JSON.stringify(check.data))
  }

  // ── 4. Reply handling advances a fresh 'contacted' lead ─────────────────────
  console.log("\n  4. Reply handling — 'contacted' -> 'replied'")
  {
    const db = makeFakeSupabase({
      leads: [{ id: 'lead-1', business_name: 'Biz', status: 'contacted' }],
      emails: [{ id: 'row-1', lead_id: 'lead-1', type: 'initial_pitch', replied_at: null }],
      activity_log: [],
    })
    await handleEmailReply('lead-1', db)
    const lead = await db.from('leads').select().eq('id', 'lead-1').maybeSingle()
    const email = await db.from('emails').select().eq('id', 'row-1').maybeSingle()
    assert(lead.data?.status === 'replied', "Lead status advances from 'contacted' to 'replied'")
    assert(email.data?.replied_at !== null, 'initial_pitch email row gets replied_at set')
  }

  // ── 5. Reply handling does not regress a lead past 'contacted' ─────────────
  console.log('\n  5. Reply handling — does not regress an advanced lead')
  {
    const db = makeFakeSupabase({
      leads: [{ id: 'lead-1', business_name: 'Biz', status: 'negotiating' }],
      emails: [{ id: 'row-1', lead_id: 'lead-1', type: 'initial_pitch', replied_at: null }],
      activity_log: [],
    })
    await handleEmailReply('lead-1', db)
    const lead = await db.from('leads').select().eq('id', 'lead-1').maybeSingle()
    const email = await db.from('emails').select().eq('id', 'row-1').maybeSingle()
    assert(lead.data?.status === 'negotiating', "Lead already at 'negotiating' is NOT regressed back to 'replied'", JSON.stringify(lead.data))
    assert(email.data?.replied_at !== null, 'replied_at is still recorded even though status was not changed')
  }

  // ── 6. Duplicate reply delivery is idempotent ───────────────────────────────
  console.log('\n  6. Duplicate webhook delivery — reply replay is idempotent')
  {
    const db = makeFakeSupabase({
      leads: [{ id: 'lead-1', business_name: 'Biz', status: 'contacted' }],
      emails: [{ id: 'row-1', lead_id: 'lead-1', type: 'initial_pitch', replied_at: null }],
      activity_log: [],
    })
    await handleEmailReply('lead-1', db)
    await handleEmailReply('lead-1', db) // redelivered
    const lead = await db.from('leads').select().eq('id', 'lead-1').maybeSingle()
    assert(lead.data?.status === 'replied', "Lead stays 'replied' (not bounced back or double-transitioned) after redelivery", JSON.stringify(lead.data))
  }

  // ── 7. Inbound reply matches via In-Reply-To header ─────────────────────────
  console.log('\n  7. Inbound email.received — matches via In-Reply-To header')
  {
    const db = makeFakeSupabase({
      leads: [{ id: 'lead-1', business_name: 'Biz', status: 'contacted' }],
      emails: [{ id: 'row-1', lead_id: 'lead-1', type: 'initial_pitch', message_id: '<abc@aussieventure.com>', replied_at: null }],
      activity_log: [],
    })
    const fetchHeaders = async () => ({ 'In-Reply-To': '<abc@aussieventure.com>' })
    await handleInboundEmail({ emailId: 'in_1', from: 'someone@biz.com' }, db, fetchHeaders)
    const lead = await db.from('leads').select().eq('id', 'lead-1').maybeSingle()
    assert(lead.data?.status === 'replied', 'Lead is matched via In-Reply-To and marked replied', JSON.stringify(lead.data))
  }

  // ── 8. Inbound reply falls back to from-address match ───────────────────────
  console.log('\n  8. Inbound email.received — falls back to from-address match')
  {
    const db = makeFakeSupabase({
      leads: [{ id: 'lead-1', business_name: 'Biz', status: 'contacted', email: 'owner@biz.com' }],
      emails: [{ id: 'row-1', lead_id: 'lead-1', type: 'initial_pitch', message_id: '<abc@aussieventure.com>', replied_at: null }],
      activity_log: [],
    })
    const fetchHeaders = async () => null // no headers available (e.g. fetch failed)
    await handleInboundEmail({ emailId: 'in_1', from: 'OWNER@biz.com' }, db, fetchHeaders)
    const lead = await db.from('leads').select().eq('id', 'lead-1').maybeSingle()
    assert(lead.data?.status === 'replied', 'Lead is matched via from-address fallback (case-insensitive) and marked replied', JSON.stringify(lead.data))
  }

  // ── 9. Inbound reply with no match at all is a safe no-op ──────────────────
  console.log('\n  9. Inbound email.received — no match is a safe no-op')
  {
    const db = makeFakeSupabase({
      leads: [{ id: 'lead-1', business_name: 'Biz', status: 'contacted', email: 'owner@biz.com' }],
      emails: [{ id: 'row-1', lead_id: 'lead-1', type: 'initial_pitch', message_id: '<abc@aussieventure.com>', replied_at: null }],
      activity_log: [],
    })
    const fetchHeaders = async () => null
    let threw = false
    try {
      await handleInboundEmail({ emailId: 'in_1', from: 'nobody@unrelated.com' }, db, fetchHeaders)
    } catch {
      threw = true
    }
    const lead = await db.from('leads').select().eq('id', 'lead-1').maybeSingle()
    assert(!threw, 'No match does not throw')
    assert(lead.data?.status === 'contacted', 'Unrelated inbound email does not change any lead status', JSON.stringify(lead.data))
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
