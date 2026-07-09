/**
 * scripts/investigate-81.ts
 *
 * Re-runs the final investigation: every lead that has ≥1 email with
 * status='email_sync_failed'. Shows per-lead:
 *   - Lead ID, business name, lead status, pipeline stage
 *   - Initial email status
 *   - Latest follow-up stage sent (none / FU1 / FU2 / FU3)
 *   - Why it is included
 *
 * Also checks whether previously-sync-failed emails have been repaired
 * (promoted to 'sent') via the repair script.
 *
 * Read-only. No mutations.
 * Run: npx tsx scripts/investigate-81.ts
 */

import * as dotenv from 'dotenv'
import * as path from 'path'
import { createClient } from '@supabase/supabase-js'
import { isFuEmailSent } from '@/lib/followup-eligibility'
import { rawStatusToStage } from '@/lib/lead-status'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const SEP = '═'.repeat(108)
const DIV = '─'.repeat(108)

interface EmailRow {
  id: string
  type: string
  status: string
  sent_at: string | null
  resend_id: string | null
}

interface LeadRow {
  id: string
  business_name: string
  status: string
  emails: EmailRow[]
}

async function main(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('✗ NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ── Sanity check: overall email status counts ────────────────────────────────
  console.log('\n' + SEP)
  console.log('  EMAIL STATUS DISTRIBUTION (all emails)')
  console.log(SEP)

  for (const status of ['pending_send', 'sent', 'failed', 'bounced', 'email_sync_failed']) {
    const { count } = await supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('status', status)
    console.log(`  ${status.padEnd(24)} ${count ?? 0}`)
  }

  // ── Check activity_log for repair events ────────────────────────────────────
  console.log('\n' + DIV)
  console.log('  REPAIR EVENTS IN ACTIVITY_LOG (email_sync_repaired)')
  console.log(DIV)

  const { data: repairEvents, error: repairErr } = await supabase
    .from('activity_log')
    .select('id, lead_id, description, metadata, created_at')
    .eq('event_type', 'email_sync_repaired')
    .order('created_at', { ascending: false })
    .limit(200)

  if (repairErr) {
    console.log('  (activity_log query failed — table may not exist or column differs)')
    console.log('  Error:', repairErr.message)
  } else if (!repairEvents?.length) {
    console.log('  No email_sync_repaired events found.')
  } else {
    console.log(`  Found ${repairEvents.length} repair event(s):`)
    for (const ev of repairEvents.slice(0, 10)) {
      console.log(`  - lead_id=${ev.lead_id}  at=${ev.created_at}  ${ev.description}`)
    }
    if (repairEvents.length > 10) {
      console.log(`  … and ${repairEvents.length - 10} more`)
    }
  }

  // ── Check emails that were recently promoted to 'sent' with a resend_id ─────
  // These are the most likely candidates for the formerly-sync-failed emails.
  console.log('\n' + DIV)
  console.log('  RECENTLY UPDATED EMAILS (updated_at within last 48h, status=sent, resend_id present)')
  console.log(DIV)

  const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
  const { data: recentlySent, error: rsErr } = await supabase
    .from('emails')
    .select('id, lead_id, type, status, sent_at, resend_id, updated_at')
    .eq('status', 'sent')
    .not('resend_id', 'is', null)
    .gte('updated_at', cutoff)
    .order('updated_at', { ascending: false })
    .limit(200)

  if (rsErr) {
    console.log('  Error:', rsErr.message)
  } else if (!recentlySent?.length) {
    console.log(`  No sent emails updated since ${cutoff.slice(0, 16)}Z.`)
  } else {
    console.log(`  ${recentlySent.length} sent email(s) updated within 48h — these may have been repaired:`)
    for (const e of recentlySent.slice(0, 10)) {
      console.log(`  - id=${e.id}  lead=${e.lead_id}  type=${e.type}  resend=${e.resend_id}  updated=${e.updated_at}`)
    }
    if (recentlySent.length > 10) console.log(`  … and ${recentlySent.length - 10} more`)
  }

  // ── Main query: leads with ≥1 email_sync_failed email ───────────────────────
  console.log('\n' + SEP)
  console.log('  MAIN QUERY — leads with ≥1 email_sync_failed email (current state)')
  console.log(SEP)

  const { data: syncFailedEmails, error: sfErr } = await supabase
    .from('emails')
    .select('lead_id')
    .eq('status', 'email_sync_failed')

  if (sfErr) {
    console.error('✗ Failed to fetch sync-failed emails:', sfErr.message)
    process.exit(1)
  }

  const syncFailedLeadIdSet = new Set((syncFailedEmails ?? []).map((e) => e.lead_id as string))
  const syncFailedLeadIds   = [...syncFailedLeadIdSet]

  if (!syncFailedLeadIds.length) {
    console.log(`\n  COUNT: 0 leads currently have email_sync_failed emails.`)
    console.log(`\n  ── INTERPRETATION ─────────────────────────────────────────────`)
    console.log(`  If the previous investigation found 81, they were likely repaired`)
    console.log(`  (promoted to status='sent') before this run. See repair events above.`)
    console.log('\n' + SEP)
    console.log('  ✓ Read-only complete — no emails sent, no DB changes made')
    console.log(SEP + '\n')
    return
  }

  // Fetch full lead + email data
  const CHUNK = 50
  const allLeads: LeadRow[] = []

  for (let i = 0; i < syncFailedLeadIds.length; i += CHUNK) {
    const chunk = syncFailedLeadIds.slice(i, i + CHUNK)
    const { data, error: chunkErr } = await supabase
      .from('leads')
      .select('id, business_name, status, emails(id, type, status, sent_at, resend_id)')
      .in('id', chunk)

    if (chunkErr) {
      console.error(`✗ Chunk ${i}–${i + CHUNK} failed:`, chunkErr.message)
      process.exit(1)
    }

    allLeads.push(...((data ?? []) as LeadRow[]))
  }

  // Compute per-lead detail
  interface LeadDetail {
    idx:                number
    id:                 string
    businessName:       string
    leadStatus:         string
    pipelineStage:      string
    initialEmailStatus: string
    latestFuStage:      string
    syncFailedTypes:    string[]
    hasResendId:        boolean
    hasSentAt:          boolean
    reason:             string
  }

  const details: LeadDetail[] = []

  for (const lead of allLeads) {
    const emails     = (lead.emails ?? []) as EmailRow[]
    const syncFailed = emails.filter((e) => e.status === 'email_sync_failed')
    if (!syncFailed.length) continue

    const initialRow         = emails.find((e) => e.type === 'initial_pitch')
    const initialEmailStatus = initialRow ? initialRow.status : 'missing'

    const hasFu1 = emails.some((e) => e.type === 'follow_up_1' && isFuEmailSent(e))
    const hasFu2 = emails.some((e) => e.type === 'follow_up_2' && isFuEmailSent(e))
    const hasFu3 = emails.some((e) => e.type === 'follow_up_3' && isFuEmailSent(e))

    let latestFuStage = 'none'
    if (hasFu3)      latestFuStage = 'FU3'
    else if (hasFu2) latestFuStage = 'FU2'
    else if (hasFu1) latestFuStage = 'FU1'

    const pipelineStage = rawStatusToStage(lead.status) ?? 'pre-contact'
    const uniqueTypes   = [...new Set(syncFailed.map((e) => e.type))]
    const hasResendId   = syncFailed.some((e) => e.resend_id !== null)
    const hasSentAt     = syncFailed.some((e) => e.sent_at   !== null)

    const reasonParts = [
      `${syncFailed.length} email_sync_failed row${syncFailed.length > 1 ? 's' : ''} (${uniqueTypes.join('+')}).`,
      hasResendId ? 'resend_id present → auto-repairable.' : 'No resend_id → needs manual Resend check.',
      hasSentAt   ? 'sent_at set → isFuEmailSent=true.'    : 'No sent_at → isFuEmailSent=false; FU eligibility affected.',
    ]

    details.push({
      idx: 0,
      id: lead.id,
      businessName: lead.business_name,
      leadStatus: lead.status,
      pipelineStage,
      initialEmailStatus,
      latestFuStage,
      syncFailedTypes: uniqueTypes,
      hasResendId,
      hasSentAt,
      reason: reasonParts.join(' '),
    })
  }

  const stageOrder: Record<string, number> = {
    'pre-contact': 0, contacted: 1, replied: 2, negotiating: 3, closed: 4, dead: 5,
  }
  details.sort((a, b) => {
    const sd = (stageOrder[a.pipelineStage] ?? 9) - (stageOrder[b.pipelineStage] ?? 9)
    return sd !== 0 ? sd : a.businessName.localeCompare(b.businessName)
  })
  details.forEach((d, i) => { d.idx = i + 1 })

  console.log(`\n  COUNT: ${details.length} leads currently have ≥1 email_sync_failed email.\n`)

  for (const d of details) {
    console.log(`  [${String(d.idx).padStart(3)}]  ${d.id}`)
    console.log(`         Business : ${d.businessName}`)
    console.log(`         Status   : ${d.leadStatus}   Stage: ${d.pipelineStage}`)
    console.log(`         Init eml : ${d.initialEmailStatus}`)
    console.log(`         FU stage : ${d.latestFuStage}`)
    console.log(`         Reason   : ${d.reason}`)
    console.log()
  }

  console.log(DIV)
  console.log(`  TOTAL: ${details.length} leads`)

  console.log('\n' + DIV)
  console.log('  BY EMAIL TYPE')
  console.log(DIV)
  const byType: Record<string, number> = {}
  for (const d of details) for (const t of d.syncFailedTypes) byType[t] = (byType[t] ?? 0) + 1
  for (const [t, c] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${t.padEnd(20)} ${c}`)
  }

  console.log('\n' + DIV)
  console.log('  BY LEAD STATUS')
  console.log(DIV)
  const byStatus: Record<string, number> = {}
  for (const d of details) byStatus[d.leadStatus] = (byStatus[d.leadStatus] ?? 0) + 1
  for (const [s, c] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s.padEnd(20)} ${c}`)
  }

  console.log('\n' + DIV)
  console.log('  BY LATEST FU STAGE')
  console.log(DIV)
  const byFu: Record<string, number> = {}
  for (const d of details) byFu[d.latestFuStage] = (byFu[d.latestFuStage] ?? 0) + 1
  for (const [f, c] of Object.entries(byFu).sort()) {
    console.log(`    ${f.padEnd(8)} ${c}`)
  }

  console.log('\n' + SEP)
  console.log('  ✓ Read-only complete — no emails sent, no DB changes made')
  console.log(SEP + '\n')
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
