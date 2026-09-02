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

import {
  handleEmailBounce,
  handleEmailReply,
  handleInboundEmail,
  handleTerminalDeliveryFailure,
  processInboundReply,
} from '../agents/tracker'
import { isDeliverySuppressedForAddress } from '../src/lib/delivery-suppression'
import { parseHostingerWebhookPayload, verifyHostingerBearerSecret } from '../src/lib/hostinger-webhook'

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

async function expectReject(promise: Promise<unknown>, pattern: RegExp, label: string): Promise<void> {
  try {
    await promise
    assert(false, label, 'promise resolved')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    assert(pattern.test(message), label, message)
  }
}

// ─── Minimal in-memory fake of the Supabase query-builder surface actually
// used by agents/tracker.ts: .from(table).select/update/insert().eq/ilike/limit()
// then either .single()/.maybeSingle() or awaited directly. Not a general
// Postgrest mock — just enough to exercise the real handler logic.
type Row = Record<string, unknown>

function makeFakeSupabase(tables: Record<string, Row[]>, failUpdates: Record<string, string> = {}) {
  return {
    async rpc(name: string, args: { p_lead_id: string; p_email: string }) {
      if (name !== 'suppress_lead_delivery_email') return { error: { message: 'unknown rpc' } }
      const lead = (tables.leads ?? []).find((row) => row.id === args.p_lead_id)
      if (!lead) return { error: { message: 'lead not found' } }
      const current = (lead.delivery_suppressed_emails as string[] | undefined) ?? []
      const normalized = args.p_email.trim().toLowerCase()
      lead.delivery_suppressed_emails = current.includes(normalized) ? current : [...current, normalized]
      return { error: null }
    },
    from(table: string) {
      const eqFilters: [string, unknown][] = []
      const isFilters: [string, unknown][] = []
      const ilikeFilters: [string, unknown][] = []
      let limitN: number | undefined
      let mode: 'select' | 'update' | null = null
      let patch: Row = {}

      const rowsFor = () => (tables[table] ??= [])

      const applyFilters = (list: Row[]) => {
        let out = list
        for (const [col, val] of eqFilters) out = out.filter((r) => r[col] === val)
        for (const [col, val] of isFilters) out = out.filter((r) => r[col] === val)
        for (const [col, val] of ilikeFilters) {
          out = out.filter((r) => typeof r[col] === 'string' && (r[col] as string).toLowerCase() === String(val).toLowerCase())
        }
        if (limitN !== undefined) out = out.slice(0, limitN)
        return out
      }

      const exec = async () => {
        const matched = applyFilters(rowsFor())
        if (mode === 'update') {
          if (failUpdates[table]) return { data: null, error: { message: failUpdates[table] } }
          for (const row of matched) Object.assign(row, patch)
          return { data: null, error: null }
        }
        return { data: matched, error: null }
      }

      const builder = {
        eq(col: string, val: unknown) { eqFilters.push([col, val]); return builder },
        is(col: string, val: unknown) { isFilters.push([col, val]); return builder },
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

  console.log('\n  4a. Reply write failures throw before activity logging')
  {
    const tables = {
      leads: [{ id: 'lead-error', business_name: 'Write Error', status: 'contacted' }],
      emails: [{ id: 'email-error', lead_id: 'lead-error', type: 'initial_pitch', replied_at: null }],
      activity_log: [] as Row[],
    }
    await expectReject(
      handleEmailReply('lead-error', makeFakeSupabase(tables, { leads: 'lead update failed' })),
      /Reply lead status could not be stored/,
      'Lead status update error throws',
    )
    assert(tables.activity_log.length === 0, 'Lead status write failure cannot log reply_received')

    tables.leads[0].status = 'negotiating'
    await expectReject(
      handleEmailReply('lead-error', makeFakeSupabase(tables, { emails: 'replied_at update failed' })),
      /Reply email timestamp could not be stored/,
      'replied_at update error throws',
    )
    assert(tables.activity_log.length === 0, 'replied_at write failure cannot log reply_received')
  }

  console.log('\n  4b. A matched email whose lead disappeared throws with diagnostics')
  {
    const db = makeFakeSupabase({
      leads: [],
      emails: [{ id: 'orphan-email', lead_id: 'missing-lead', message_id: '<orphan@example.test>' }],
      activity_log: [],
    })
    await expectReject(processInboundReply({
      provider: 'hostinger', providerMessageId: 'missing-lead-message', from: 'owner@example.test',
      inReplyTo: ['<orphan@example.test>'], headers: {}, receiptId: 'receipt-missing-lead',
    }, db), /Matched inbound reply lead missing-lead could not be loaded/, 'Missing matched lead throws')
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

  {
    const db = makeFakeSupabase({
      leads: [{ id: 'lead-dead', business_name: 'Late Biz', status: 'dead' }],
      emails: [{ id: 'late-row', lead_id: 'lead-dead', type: 'initial_pitch', replied_at: null }],
      activity_log: [],
    })
    await handleEmailReply('lead-dead', db)
    const lead = await db.from('leads').select().eq('id', 'lead-dead').maybeSingle()
    assert(lead.data?.status === 'replied', 'A genuine late reply revives a dead lead to replied')
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
    const firstEmail = await db.from('emails').select().eq('id', 'row-1').maybeSingle()
    await handleEmailReply('lead-1', db) // redelivered
    const lead = await db.from('leads').select().eq('id', 'lead-1').maybeSingle()
    const replayedEmail = await db.from('emails').select().eq('id', 'row-1').maybeSingle()
    assert(lead.data?.status === 'replied', "Lead stays 'replied' (not bounced back or double-transitioned) after redelivery", JSON.stringify(lead.data))
    assert(replayedEmail.data?.replied_at === firstEmail.data?.replied_at, 'Duplicate delivery preserves the original reply timestamp')
  }

  // ── 7. Inbound reply matches via In-Reply-To header ─────────────────────────
  console.log('\n  7. Inbound email.received — matches via In-Reply-To header')
  {
    const db = makeFakeSupabase({
      leads: [{ id: 'lead-1', business_name: 'Biz', status: 'contacted' }],
      emails: [
        { id: 'initial-1', lead_id: 'lead-1', type: 'initial_pitch', message_id: '<initial@aussieventure.com>', replied_at: null },
        { id: 'fu1-1', lead_id: 'lead-1', type: 'follow_up_1', message_id: '<abc@aussieventure.com>', replied_at: null },
      ],
      activity_log: [],
    })
    const fetchHeaders = async () => ({ 'In-Reply-To': '<abc@aussieventure.com>' })
    await handleInboundEmail({ emailId: 'in_1', from: 'someone@biz.com' }, db, fetchHeaders)
    const lead = await db.from('leads').select().eq('id', 'lead-1').maybeSingle()
    assert(lead.data?.status === 'replied', 'Lead is matched via In-Reply-To and marked replied', JSON.stringify(lead.data))
    const initial = await db.from('emails').select().eq('id', 'initial-1').maybeSingle()
    const followUp = await db.from('emails').select().eq('id', 'fu1-1').maybeSingle()
    assert(followUp.data?.replied_at !== null, 'The exact outbound email identified by In-Reply-To gets replied_at')
    assert(initial.data?.replied_at === null, 'Other thread emails are not incorrectly marked replied')
  }

  // ── 8. Inbound reply falls back to from-address match ───────────────────────
  console.log('\n  8. Inbound email.received — falls back to from-address match')
  {
    const db = makeFakeSupabase({
      leads: [{ id: 'lead-1', business_name: 'Biz', status: 'contacted', email: 'owner@biz.com' }],
      emails: [{ id: 'row-1', lead_id: 'lead-1', type: 'initial_pitch', message_id: '<abc@aussieventure.com>', sent_at: '2026-01-01T00:00:00Z', replied_at: null }],
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
  console.log('\n  10. Automated/system inbound mail is ignored')
  {
    const db = makeFakeSupabase({
      leads: [{ id: 'lead-auto', business_name: 'Biz', status: 'contacted', email: 'owner@biz.com' }],
      emails: [{ id: 'auto-row', lead_id: 'lead-auto', type: 'initial_pitch', message_id: '<auto@aussieventure.com>', replied_at: null }],
      activity_log: [],
    })
    await handleInboundEmail(
      { emailId: 'in_auto', from: 'owner@biz.com', subject: 'Automatic reply: away' },
      db,
      async () => ({ 'In-Reply-To': '<auto@aussieventure.com>', 'Auto-Submitted': 'auto-replied' }),
    )
    const lead = await db.from('leads').select().eq('id', 'lead-auto').maybeSingle()
    const email = await db.from('emails').select().eq('id', 'auto-row').maybeSingle()
    assert(lead.data?.status === 'contacted', 'Out-of-office message does not mark the lead replied')
    assert(email.data?.replied_at === null, 'Out-of-office message does not set replied_at')

    await handleInboundEmail(
      { emailId: 'in_dsn', from: 'mailer-daemon@example.com', subject: 'Delivery Status Notification' },
      db,
      async () => ({ 'In-Reply-To': '<auto@aussieventure.com>' }),
    )
    const afterDeliveryNotice = await db.from('leads').select().eq('id', 'lead-auto').maybeSingle()
    assert(afterDeliveryNotice.data?.status === 'contacted', 'Delivery-system message does not mark the lead replied')
  }

  console.log('\n  11. Hostinger payload parsing is defensive')
  {
    assert(verifyHostingerBearerSecret('Bearer webhook-secret', 'webhook-secret'), 'Valid Hostinger Bearer secret is accepted')
    assert(!verifyHostingerBearerSecret('Bearer wrong', 'webhook-secret'), 'Invalid Hostinger Bearer secret is rejected')
    assert(!verifyHostingerBearerSecret(null, 'webhook-secret') && !verifyHostingerBearerSecret('Bearer webhook-secret', undefined), 'Missing header or configured secret fails closed')

    const locator = parseHostingerWebhookPayload({
      event: 'message.received',
      mailbox: { resourceId: 'AC_mailbox', address: 'hello@aussieventure.com' },
      message: {
        uid: 42,
        path: 'INBOX',
        message_id: '<reply@example.com>',
        from: { name: 'Owner', address: 'Owner@Biz.com' },
        to: [{ address: 'hello@aussieventure.com' }],
        subject: 'Re: Collab',
      },
      timestamp: '2026-09-01T00:00:00Z',
    })
    assert(locator.eventType === 'message.received', 'Hostinger event type is parsed')
    assert(locator.mailboxId === 'AC_mailbox' && locator.uid === 42 && locator.folder === 'INBOX', 'Mailbox resource ID, UID, and folder are parsed')
    assert(locator.from === 'Owner@Biz.com' && locator.providerMessageId === '<reply@example.com>', 'Nested sender and provider Message-ID are parsed')

    const alternate = parseHostingerWebhookPayload({
      type: 'message.received',
      data: { account_resource_id: 'AC_alternate', folder_path: 'INBOX.Support', message_uid: '77' },
    })
    assert(alternate.mailboxId === 'AC_alternate' && alternate.uid === 77 && alternate.folder === 'INBOX.Support', 'Alternate documented-style identifier names are accepted safely')
  }

  console.log('\n  12. References are matched newest-first')
  {
    const db = makeFakeSupabase({
      leads: [{ id: 'lead-ref', business_name: 'Ref Biz', status: 'contacted', email: 'owner@ref.test' }],
      emails: [
        { id: 'old-ref', lead_id: 'lead-ref', type: 'initial_pitch', message_id: '<old@aussieventure.com>', sent_at: '2026-01-01T00:00:00Z', replied_at: null },
        { id: 'new-ref', lead_id: 'lead-ref', type: 'follow_up_1', message_id: '<new@aussieventure.com>', sent_at: '2026-02-01T00:00:00Z', replied_at: null },
      ],
      activity_log: [],
    })
    const result = await processInboundReply({
      provider: 'hostinger', providerMessageId: 'hostinger-1', from: 'Owner <owner@ref.test>',
      references: ['<old@aussieventure.com> <new@aussieventure.com>'], headers: {},
      receivedAt: '2026-09-01T01:02:03Z',
    }, db)
    const oldEmail = await db.from('emails').select().eq('id', 'old-ref').maybeSingle()
    const newEmail = await db.from('emails').select().eq('id', 'new-ref').maybeSingle()
    assert(result.outcome === 'processed' && result.emailId === 'new-ref', 'Newest unique References match is selected')
    assert(oldEmail.data?.replied_at === null && newEmail.data?.replied_at === '2026-09-01T01:02:03Z', 'Only the exact referenced email receives the Hostinger timestamp')
  }

  console.log('\n  13. Ambiguous sender fallback never chooses arbitrarily')
  {
    const db = makeFakeSupabase({
      leads: [
        { id: 'lead-a', business_name: 'A', status: 'contacted', email: 'shared@biz.test' },
        { id: 'lead-b', business_name: 'B', status: 'dead', email: 'SHARED@biz.test' },
      ],
      emails: [
        { id: 'email-a', lead_id: 'lead-a', type: 'initial_pitch', sent_at: '2026-01-01T00:00:00Z', replied_at: null },
        { id: 'email-b', lead_id: 'lead-b', type: 'initial_pitch', sent_at: '2026-01-02T00:00:00Z', replied_at: null },
      ],
      activity_log: [],
    })
    const result = await processInboundReply({
      provider: 'hostinger', providerMessageId: 'hostinger-ambiguous', from: 'Person <shared@biz.test>', headers: {},
    }, db)
    const leadA = await db.from('leads').select().eq('id', 'lead-a').maybeSingle()
    const leadB = await db.from('leads').select().eq('id', 'lead-b').maybeSingle()
    const marker = (await db.from('activity_log').select().eq('event_type', 'inbound_reply_unmatched').maybeSingle()).data
    assert(result.outcome === 'unmatched_ambiguous', 'Ambiguous sender returns unmatched_ambiguous')
    assert(leadA.data?.status === 'contacted' && leadB.data?.status === 'dead', 'Neither ambiguous lead status is changed')
    assert((marker?.metadata as Row | undefined)?.status === 'unmatched_ambiguous', 'Ambiguous inbound message is marked in activity_log')
  }

  console.log('\n  14. Sender fallback requires prior sent outreach')
  {
    const db = makeFakeSupabase({
      leads: [{ id: 'lead-unsent', business_name: 'Unsent', status: 'contacted', email: 'unsent@biz.test' }],
      emails: [{ id: 'email-unsent', lead_id: 'lead-unsent', type: 'initial_pitch', sent_at: null, replied_at: null }],
      activity_log: [],
    })
    const result = await processInboundReply({
      provider: 'hostinger', providerMessageId: 'hostinger-unsent', from: 'unsent@biz.test', headers: {},
    }, db)
    const lead = await db.from('leads').select().eq('id', 'lead-unsent').maybeSingle()
    assert(result.outcome === 'unmatched' && lead.data?.status === 'contacted', 'A matching address without sent outreach is a safe no-op')
  }

  console.log('\n  15. Terminal events suppress the address and cancel pending follow-ups')
  {
    const db = makeFakeSupabase({
      leads: [{ id: 'lead-t', email: 'Owner@Biz.com', delivery_suppressed_emails: [] }],
      emails: [{ id: 'email-t', lead_id: 'lead-t', type: 'follow_up_1', resend_id: 'rs_failed', status: 'sent' }],
      follow_ups: [
        { id: 'fu2', lead_id: 'lead-t', status: 'scheduled' },
        { id: 'old', lead_id: 'lead-t', status: 'sent' },
      ],
      activity_log: [],
    })
    const handled = await handleTerminalDeliveryFailure({
      taggedLeadId: 'lead-t', resendId: 'rs_failed', eventType: 'email.failed',
      recipient: 'Owner@Biz.com', providerReason: { reason: 'provider terminal failure' },
    }, db)
    const email = await db.from('emails').select().eq('id', 'email-t').maybeSingle()
    const lead = await db.from('leads').select().eq('id', 'lead-t').maybeSingle()
    const pending = await db.from('follow_ups').select().eq('id', 'fu2').maybeSingle()
    const sent = await db.from('follow_ups').select().eq('id', 'old').maybeSingle()
    assert(handled && email.data?.status === 'failed', 'email.failed is persisted as terminal failed')
    assert(isDeliverySuppressedForAddress('owner@biz.com', lead.data?.delivery_suppressed_emails as string[]), 'Failed recipient is suppressed case-insensitively')
    assert(pending.data?.status === 'cancelled' && sent.data?.status === 'sent', 'Only scheduled follow-ups are cancelled')
  }

  console.log('\n  11. Terminal precedence and duplicate delivery are idempotent')
  {
    const tables = {
      leads: [{ id: 'lead-p', email: 'p@example.com', delivery_suppressed_emails: [] as string[] }],
      emails: [{ id: 'email-p', lead_id: 'lead-p', type: 'initial_pitch', resend_id: 'rs_p', status: 'sent' }],
      follow_ups: [] as Row[], activity_log: [] as Row[],
    }
    const db = makeFakeSupabase(tables)
    await handleTerminalDeliveryFailure({ resendId: 'rs_p', eventType: 'email.bounced', recipient: 'p@example.com' }, db)
    await handleTerminalDeliveryFailure({ resendId: 'rs_p', eventType: 'email.bounced', recipient: 'p@example.com' }, db)
    await handleTerminalDeliveryFailure({ resendId: 'rs_p', eventType: 'email.failed', recipient: 'p@example.com' }, db)
    assert(tables.emails[0].status === 'bounced', 'First terminal state is not overwritten by a later event')
    assert(tables.activity_log.length === 3, 'Each provider delivery is logged while repeated state changes remain idempotent')
    assert(!isDeliverySuppressedForAddress('new@example.com', tables.leads[0].delivery_suppressed_emails), 'A different address remains eligible')
  }

  console.log('\n  12. Late failure for an old address does not cancel outreach to a replacement address')
  {
    const tables = {
      leads: [{ id: 'lead-new', email: 'new@example.com', delivery_suppressed_emails: [] as string[] }],
      emails: [{ id: 'email-old', lead_id: 'lead-new', type: 'initial_pitch', resend_id: 'rs_old', status: 'sent' }],
      follow_ups: [{ id: 'fu-new', lead_id: 'lead-new', status: 'scheduled' }],
      activity_log: [] as Row[],
    }
    const db = makeFakeSupabase(tables)
    await handleTerminalDeliveryFailure({ resendId: 'rs_old', eventType: 'email.suppressed', recipient: 'old@example.com' }, db)
    assert(tables.emails[0].status === 'suppressed', 'email.suppressed is persisted using the provider status')
    assert(tables.follow_ups[0].status === 'scheduled', 'Replacement-address pending outreach is not cancelled by an old-address event')
    assert(isDeliverySuppressedForAddress('old@example.com', tables.leads[0].delivery_suppressed_emails), 'Old failed address remains suppressed')
    assert(!isDeliverySuppressedForAddress('new@example.com', tables.leads[0].delivery_suppressed_emails), 'Replacement address remains sendable')
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
