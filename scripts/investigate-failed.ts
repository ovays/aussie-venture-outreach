/**
 * scripts/investigate-failed.ts
 *
 * Investigates all emails with status='failed'.
 * Groups by: email type, date (week), resend_id presence, and whether
 * the lead was later contacted successfully via a sent email of the same type.
 * Also mines activity_log for failure reasons.
 *
 * Read-only. No mutations.
 * Run: npx tsx scripts/investigate-failed.ts
 */

import * as dotenv from 'dotenv'
import * as path from 'path'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const SEP = '═'.repeat(90)
const DIV = '─'.repeat(90)

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('✗ NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set')
    process.exit(1)
  }

  const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ── 1. Overall email status distribution ─────────────────────────────────────
  console.log('\n' + SEP)
  console.log('  1. EMAIL STATUS DISTRIBUTION (all emails)')
  console.log(SEP)

  for (const status of ['pending_send', 'sent', 'failed', 'bounced', 'email_sync_failed']) {
    const { count } = await supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('status', status)
    console.log(`  ${status.padEnd(24)} ${String(count ?? 0).padStart(6)}`)
  }

  // ── 2. Fetch all failed emails ────────────────────────────────────────────────
  console.log('\n' + SEP)
  console.log('  2. FAILED EMAIL DEEP DIVE')
  console.log(SEP)

  const PAGE = 1000
  let allFailed: Array<{
    id: string
    lead_id: string
    type: string
    resend_id: string | null
    sent_at: string | null
    created_at: string
  }> = []

  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('emails')
      .select('id, lead_id, type, resend_id, sent_at, created_at')
      .eq('status', 'failed')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1)

    if (error) { console.error('✗ Failed to fetch:', error.message); process.exit(1) }
    if (!data || data.length === 0) break
    allFailed.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }

  console.log(`\n  Total failed emails: ${allFailed.length}\n`)

  if (allFailed.length === 0) {
    console.log('  No failed emails found.')
    return
  }

  // ── 3. By email type ─────────────────────────────────────────────────────────
  console.log(DIV)
  console.log('  3. BY EMAIL TYPE')
  console.log(DIV)
  const byType: Record<string, number> = {}
  for (const e of allFailed) byType[e.type] = (byType[e.type] ?? 0) + 1
  for (const [t, c] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    const pct = ((c / allFailed.length) * 100).toFixed(1)
    console.log(`  ${t.padEnd(24)} ${String(c).padStart(5)}  (${pct}%)`)
  }

  // ── 4. By week (created_at) ──────────────────────────────────────────────────
  console.log('\n' + DIV)
  console.log('  4. BY WEEK (created_at)')
  console.log(DIV)
  const byWeek: Record<string, number> = {}
  for (const e of allFailed) {
    const d = new Date(e.created_at)
    // Monday of that week
    const day = d.getUTCDay()
    const diff = (day === 0 ? -6 : 1 - day)
    d.setUTCDate(d.getUTCDate() + diff)
    const week = d.toISOString().slice(0, 10)
    byWeek[week] = (byWeek[week] ?? 0) + 1
  }
  for (const [w, c] of Object.entries(byWeek).sort()) {
    console.log(`  week of ${w}   ${String(c).padStart(5)}`)
  }

  // ── 5. Resend ID presence ────────────────────────────────────────────────────
  console.log('\n' + DIV)
  console.log('  5. RESEND ID PRESENCE')
  console.log(DIV)
  const withResendId    = allFailed.filter((e) => e.resend_id !== null && e.resend_id !== '')
  const withoutResendId = allFailed.filter((e) => !e.resend_id)
  console.log(`  Has resend_id     ${String(withResendId.length).padStart(5)}  — Resend accepted the send; failed downstream (bounce/reject)`)
  console.log(`  No resend_id      ${String(withoutResendId.length).padStart(5)}  — Resend never accepted; likely auth/config/API error`)

  // Sample resend_ids to show prefix pattern
  const sampleIds = withResendId.slice(0, 5).map((e) => e.resend_id)
  if (sampleIds.length) {
    console.log(`\n  Sample resend_ids: ${sampleIds.join(', ')}`)
  }

  // ── 6. Were they later resent? ───────────────────────────────────────────────
  console.log('\n' + DIV)
  console.log('  6. LATER RESENT SUCCESSFULLY? (same lead + type with status=sent)')
  console.log(DIV)

  // Build set of (lead_id, type) for failed emails
  type LeadTypePair = string // `${lead_id}::${type}`
  const failedPairs = new Set<LeadTypePair>()
  for (const e of allFailed) failedPairs.add(`${e.lead_id}::${e.type}`)

  // Fetch all sent emails for the same leads
  const failedLeadIds = [...new Set(allFailed.map((e) => e.lead_id))]

  let sentEmails: Array<{ lead_id: string; type: string }> = []
  const CHUNK = 200
  for (let i = 0; i < failedLeadIds.length; i += CHUNK) {
    const chunk = failedLeadIds.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from('emails')
      .select('lead_id, type')
      .eq('status', 'sent')
      .in('lead_id', chunk)
    if (error) { console.error('✗ Sent query error:', error.message); process.exit(1) }
    sentEmails.push(...(data ?? []))
  }

  const sentPairs = new Set<LeadTypePair>()
  for (const e of sentEmails) sentPairs.add(`${e.lead_id}::${e.type}`)

  let laterResentCount = 0
  let neverResentCount = 0
  const laterResentByType: Record<string, number> = {}
  const neverResentByType: Record<string, number> = {}

  for (const e of allFailed) {
    const pair = `${e.lead_id}::${e.type}`
    if (sentPairs.has(pair)) {
      laterResentCount++
      laterResentByType[e.type] = (laterResentByType[e.type] ?? 0) + 1
    } else {
      neverResentCount++
      neverResentByType[e.type] = (neverResentByType[e.type] ?? 0) + 1
    }
  }

  console.log(`  Later resent OK   ${String(laterResentCount).padStart(5)}  — lead has a sent email of same type`)
  console.log(`  Never resent      ${String(neverResentCount).padStart(5)}  — NO sent email of same type exists\n`)

  console.log('  Never resent breakdown by type:')
  for (const [t, c] of Object.entries(neverResentByType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${t.padEnd(24)} ${String(c).padStart(5)}`)
  }

  // ── 7. Activity log — failure reasons ────────────────────────────────────────
  console.log('\n' + DIV)
  console.log('  7. ACTIVITY LOG — EMAIL FAILURE EVENTS')
  console.log(DIV)

  // Look for any event types that describe email sending failures
  const failureEventTypes = [
    'email_failed',
    'email_send_failed',
    'email_bounce',
    'email_bounced',
    'send_failed',
    'email_error',
  ]

  for (const evType of failureEventTypes) {
    const { count } = await supabase
      .from('activity_log')
      .select('*', { count: 'exact', head: true })
      .eq('event_type', evType)
    if ((count ?? 0) > 0) {
      console.log(`  ${evType.padEnd(30)} ${count}`)
    }
  }

  // Also scan for any event_type containing 'fail' or 'error' or 'bounce'
  console.log('\n  Scanning distinct event_types in activity_log...')
  const { data: logEvents } = await supabase
    .from('activity_log')
    .select('event_type')
    .order('created_at', { ascending: false })
    .limit(2000)

  if (logEvents) {
    const eventTypeCounts: Record<string, number> = {}
    for (const row of logEvents) {
      eventTypeCounts[row.event_type] = (eventTypeCounts[row.event_type] ?? 0) + 1
    }
    const allEventTypes = Object.entries(eventTypeCounts).sort((a, b) => b[1] - a[1])
    const relevantTypes = allEventTypes.filter(
      ([t]) => /fail|error|bounce|send/i.test(t)
    )
    if (relevantTypes.length) {
      console.log('  Email-related event types found:')
      for (const [t, c] of relevantTypes) console.log(`    ${t.padEnd(34)} ${c}`)
    } else {
      console.log('  No fail/error/bounce/send event types found in last 2000 activity_log rows.')
    }
    console.log('\n  All distinct event types in last 2000 rows:')
    for (const [t, c] of allEventTypes) console.log(`    ${t.padEnd(34)} ${c}`)
  }

  // ── 8. Sample of failed emails without resend_id ─────────────────────────────
  if (withoutResendId.length > 0) {
    console.log('\n' + DIV)
    console.log('  8. SAMPLE — FAILED WITH NO RESEND_ID (first 10)')
    console.log(DIV)
    for (const e of withoutResendId.slice(0, 10)) {
      console.log(`  id=${e.id}  lead=${e.lead_id}  type=${e.type}  created=${e.created_at.slice(0, 10)}`)
    }
  }

  // ── 9. Sample of failed emails with resend_id but never resent ───────────────
  const failedWithIdNeverResent = withResendId.filter(
    (e) => !sentPairs.has(`${e.lead_id}::${e.type}`)
  )
  if (failedWithIdNeverResent.length > 0) {
    console.log('\n' + DIV)
    console.log('  9. SAMPLE — FAILED WITH RESEND_ID, NEVER RESENT (first 10)')
    console.log(DIV)
    for (const e of failedWithIdNeverResent.slice(0, 10)) {
      console.log(`  id=${e.id}  lead=${e.lead_id}  type=${e.type}  resend=${e.resend_id}  created=${e.created_at.slice(0, 10)}`)
    }
  }

  // ── 10. Cross: type × resend_id presence ─────────────────────────────────────
  console.log('\n' + DIV)
  console.log('  10. CROSS: TYPE × RESEND_ID PRESENCE')
  console.log(DIV)
  const crossCount: Record<string, { withId: number; noId: number }> = {}
  for (const e of allFailed) {
    if (!crossCount[e.type]) crossCount[e.type] = { withId: 0, noId: 0 }
    if (e.resend_id) crossCount[e.type].withId++
    else crossCount[e.type].noId++
  }
  console.log(`  ${'type'.padEnd(24)} ${'has_resend_id'.padStart(14)} ${'no_resend_id'.padStart(13)}`)
  for (const [t, { withId, noId }] of Object.entries(crossCount).sort((a, b) => (b[1].withId + b[1].noId) - (a[1].withId + a[1].noId))) {
    console.log(`  ${t.padEnd(24)} ${String(withId).padStart(14)} ${String(noId).padStart(13)}`)
  }

  console.log('\n' + SEP)
  console.log('  ✓ Read-only complete — no emails sent, no DB changes made')
  console.log(SEP + '\n')
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
