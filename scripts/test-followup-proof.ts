/**
 * scripts/test-followup-proof.ts
 *
 * Database evidence for two lifecycle vs sender discrepancies.
 *
 * Proof A — FU3 delta (sender=340, lifecycle=176):
 *   Count contacted leads where reactivation_sent_at IS NOT NULL,
 *   FU3 not yet sent, and daysSince >= fu3Days.
 *   Expected: ~164 (340 − 176).
 *
 * Proof B — FU1 delta (lifecycle=40, sender=0):
 *   Find contacted leads that lifecycle classifies as FU1-due
 *   (no reactivation_sent_at, initial_pitch sent, daysSince >= fu1Days)
 *   BUT that actually have a sent follow_up_1 email visible to the
 *   service-role key. These are invisible to the anon key used by the
 *   lifecycle API, which causes the phantom FU1-due count.
 *   Expected: ~40.
 *
 * Read-only. No emails sent. No DB mutations.
 * Run: npm run test:followup-proof
 */

import * as dotenv from 'dotenv'
import * as path from 'path'
import { createClient } from '@supabase/supabase-js'
import { computeFollowUpEligibility, isFuEmailSent } from '@/lib/followup-eligibility'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const SEP = '═'.repeat(66)
const DIV = '─'.repeat(66)

interface EmailRow {
  type: string
  sent_at: string | null
}

interface LeadRow {
  id: string
  business_name: string
  email: string | null
  reactivation_sent_at: string | null
  emails: EmailRow[]
}

async function main(): Promise<void> {
  console.log(SEP)
  console.log('  TEST:FOLLOWUP-PROOF  —  read-only, no emails sent')
  console.log(SEP)

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('✗ NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set')
    process.exit(1)
  }

  // Service-role client — bypasses RLS, sees every row
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ── Load settings ─────────────────────────────────────────────────────────
  const { data: settingsRows, error: settingsErr } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', ['follow_up_1_days', 'follow_up_2_days', 'follow_up_3_days'])

  if (settingsErr) {
    console.error('✗ Failed to load settings:', settingsErr.message)
    process.exit(1)
  }

  const sm: Record<string, string> = {}
  for (const row of settingsRows ?? []) sm[row.key] = row.value

  const fu1Days = parseInt(sm['follow_up_1_days'] ?? '7',  10)
  const fu2Days = parseInt(sm['follow_up_2_days'] ?? '14', 10)
  const fu3Days = parseInt(sm['follow_up_3_days'] ?? '21', 10)

  console.log(`\n  Settings: fu1Days=${fu1Days}  fu2Days=${fu2Days}  fu3Days=${fu3Days}`)
  console.log(`  All queries use service-role key (bypasses RLS)\n`)

  // ── Query all contacted leads with emails (same as sender) ────────────────
  const { data: leads, error: leadsErr } = await supabase
    .from('leads')
    .select('id, business_name, email, reactivation_sent_at, emails(type, sent_at)')
    .eq('status', 'contacted')

  if (leadsErr) {
    console.error('✗ Failed to query contacted leads:', leadsErr.message)
    process.exit(1)
  }

  const contactedLeads = (leads ?? []) as LeadRow[]
  console.log(`  Contacted leads fetched: ${contactedLeads.length}`)

  const now = new Date()

  // ─────────────────────────────────────────────────────────────────────────
  // PROOF A
  // Hypothesis: 164 leads have reactivation_sent_at set + FU3 not sent + FU3 due.
  // These appear in sender's FU3 queue (340) but NOT in lifecycle's fu3_due (176)
  // because lifecycle returns 'reactivation' for any lead with reactivation_sent_at.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n' + SEP)
  console.log('  PROOF A — reactivation_sent_at + FU3 not sent + FU3 eligible')
  console.log('  Expected count: ~164  (sender 340 − lifecycle 176)')
  console.log(SEP)

  interface ProofARow {
    name: string
    id: string
    daysSince: number
    fu3DueAtDays: number
    reactivationSentAt: string
  }

  const proofARows: ProofARow[] = []
  let proofASkippedNoInitial = 0
  let proofASkippedNoReact   = 0
  let proofASkippedFu3Sent   = 0
  let proofASkippedNotYetDue = 0
  let proofASkippedNoEmail   = 0

  for (const lead of contactedLeads) {
    if (!lead.reactivation_sent_at) {
      proofASkippedNoReact++
      continue
    }

    if (!lead.email) {
      proofASkippedNoEmail++
      continue
    }

    const emails           = lead.emails ?? []
    const initialEmail     = emails.find((e) => e.type === 'initial_pitch' && isFuEmailSent(e))

    if (!initialEmail?.sent_at) {
      proofASkippedNoInitial++
      continue
    }

    const hasFu1Sent = emails.some((e) => e.type === 'follow_up_1' && isFuEmailSent(e))
    const hasFu2Sent = emails.some((e) => e.type === 'follow_up_2' && isFuEmailSent(e))
    const hasFu3Sent = emails.some((e) => e.type === 'follow_up_3' && isFuEmailSent(e))

    if (hasFu3Sent) {
      proofASkippedFu3Sent++
      continue
    }

    // Use exact sender eligibility logic
    const eligibility = computeFollowUpEligibility(
      initialEmail.sent_at,
      hasFu1Sent,
      hasFu2Sent,
      hasFu3Sent,
      { fu1Days, fu2Days, fu3Days },
      now
    )

    if (!eligibility.isDue || eligibility.nextFuType !== 'follow_up_3') {
      proofASkippedNotYetDue++
      continue
    }

    proofARows.push({
      name:               lead.business_name,
      id:                 lead.id,
      daysSince:          eligibility.daysSince,
      fu3DueAtDays:       fu3Days,
      reactivationSentAt: lead.reactivation_sent_at,
    })
  }

  console.log(`\n  reactivation_sent_at IS NOT NULL + FU3 not sent + FU3 eligible: ${proofARows.length}`)
  console.log(`  (skipped: no react=${proofASkippedNoReact}, no email=${proofASkippedNoEmail}, no initial=${proofASkippedNoInitial}, fu3 already sent=${proofASkippedFu3Sent}, not yet due=${proofASkippedNotYetDue})`)

  console.log(`\n  Sample (up to 10):`)
  console.log(DIV)
  if (!proofARows.length) {
    console.log('  (none — hypothesis not confirmed)')
  } else {
    for (const r of proofARows.slice(0, 10)) {
      console.log(`  ${r.name}`)
      console.log(`    id=${r.id}`)
      console.log(`    daysSince=${r.daysSince}  fu3DueAtDays=${r.fu3DueAtDays}`)
      console.log(`    reactivation_sent_at=${r.reactivationSentAt}`)
    }
    if (proofARows.length > 10) {
      console.log(`  … and ${proofARows.length - 10} more`)
    }
  }

  // Verify: lifecycle 176 + proof A count should equal sender 340
  console.log(`\n  ✓ Check: lifecycle FU3 (176) + proof A count (${proofARows.length}) = ${176 + proofARows.length}`)
  console.log(`           sender FU3 = 340  ${176 + proofARows.length === 340 ? '← EXACT MATCH ✓' : '← does not match yet'}`)

  // ─────────────────────────────────────────────────────────────────────────
  // PROOF B
  // Hypothesis: lifecycle's FU1-due=40 are leads whose follow_up_1 emails
  // are invisible to the anon key (RLS) but ARE present per service-role key.
  //
  // These leads:
  //   - have no reactivation_sent_at  (otherwise lifecycle would return 'reactivation')
  //   - have a sent initial_pitch email
  //   - daysSince >= fu1Days
  //   - DO have a sent follow_up_1 email (visible to service key)
  //   → lifecycle (anon key) cannot see the FU1 email → classifies as FU1-due
  //   → sender (service key) sees FU1 → classifies correctly (not FU1-due)
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n' + SEP)
  console.log('  PROOF B — FU1 emails hidden from anon key (RLS)')
  console.log('  These are leads lifecycle calls FU1-due but service key proves have FU1 sent.')
  console.log('  Expected count: ~40')
  console.log(SEP)

  interface ProofBRow {
    name:       string
    id:         string
    daysSince:  number
    fu1SentAt:  string
  }

  const proofBRows: ProofBRow[] = []

  for (const lead of contactedLeads) {
    // Must match lifecycle's FU1-due conditions:
    // no reactivation_sent_at (otherwise lifecycle returns 'reactivation', not 'fu1')
    if (lead.reactivation_sent_at) continue
    if (!lead.email) continue

    const emails       = lead.emails ?? []
    const initialEmail = emails.find((e) => e.type === 'initial_pitch' && isFuEmailSent(e))
    if (!initialEmail?.sent_at) continue

    const fu1Email = emails.find((e) => e.type === 'follow_up_1' && isFuEmailSent(e))
    const daysSince = Math.floor(
      (now.getTime() - new Date(initialEmail.sent_at).getTime()) / 86_400_000
    )

    // Must be past fu1Days (lifecycle's is_overdue condition)
    if (daysSince < fu1Days) continue

    // The key check: service key finds a sent FU1 email.
    // If lifecycle (anon key) cannot see this, it would classify as FU1-due.
    if (!fu1Email?.sent_at) continue   // service key also sees no FU1 — not this case

    proofBRows.push({
      name:      lead.business_name,
      id:        lead.id,
      daysSince,
      fu1SentAt: fu1Email.sent_at,
    })
  }

  // These leads have FU1 sent (service key confirms), but lifecycle (anon key) counts
  // them as FU1-due — meaning the anon key cannot see the follow_up_1 email rows.

  console.log(`\n  Leads where service key finds a sent FU1 email`)
  console.log(`  but lifecycle (anon key) would classify as FU1-due: ${proofBRows.length}`)

  console.log(`\n  Per-lead detail:`)
  console.log(DIV)
  console.log(`  ${'Business name'.padEnd(40)} ${'Lead ID'.padEnd(36)} ${'FU1 email?'.padEnd(12)} Sent at`)
  console.log(DIV)

  if (!proofBRows.length) {
    console.log('  (none — service key finds no sent FU1 emails for lifecycle FU1-due leads)')
    console.log('  → RLS hypothesis not confirmed; discrepancy may be due to stale lifecycle page')
  } else {
    for (const r of proofBRows) {
      console.log(
        `  ${r.name.slice(0, 39).padEnd(40)} ${r.id.padEnd(36)} ${'yes'.padEnd(12)} ${r.fu1SentAt}`
      )
    }
    if (proofBRows.length > 40) {
      console.log(`  … and ${proofBRows.length - 40} more`)
    }
  }

  console.log(`\n  ✓ Check: proof B count (${proofBRows.length}) should equal lifecycle FU1 due (40)`)
  console.log(`           lifecycle FU1 = 40  ${proofBRows.length === 40 ? '← EXACT MATCH ✓' : `← actual: ${proofBRows.length}`}`)

  // ── Bonus: also check if timing could explain FU1 (emails sent today) ─────
  console.log('\n' + DIV)
  console.log('  BONUS — FU1 emails sent today (timing alternative explanation)')
  console.log(DIV)

  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const { count: fu1SentToday } = await supabase
    .from('emails')
    .select('*', { count: 'exact', head: true })
    .eq('type', 'follow_up_1')
    .not('sent_at', 'is', null)
    .gte('sent_at', todayStart.toISOString())

  console.log(`\n  FU1 emails with sent_at >= ${todayStart.toISOString().slice(0, 10)}: ${fu1SentToday ?? 0}`)
  if ((fu1SentToday ?? 0) >= 40) {
    console.log('  → 40+ FU1 emails sent today — lifecycle page may be stale (loaded before sender ran)')
  } else {
    console.log('  → Fewer than 40 FU1s sent today — timing alone does not explain the FU1 discrepancy')
  }

  console.log('\n' + SEP)
  console.log('  ✓ Read-only complete — no emails sent, no DB changes made')
  console.log(SEP)
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
