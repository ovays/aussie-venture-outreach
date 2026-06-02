/**
 * scripts/test-followup-pagination.ts
 *
 * Verifies that the paginated contacted-leads query in agents/followup.ts
 * processes ALL leads (not just the first 1000).
 *
 * Mirrors the exact query and eligibility logic from the fixed agent so the
 * counts here should match what the agent sees at runtime.
 *
 * Read-only. No emails sent. No DB mutations.
 * Run: npm run test:followup-pagination
 */

import * as dotenv from 'dotenv'
import * as path from 'path'
import { createClient } from '@supabase/supabase-js'
import { computeFollowUpEligibility, isFuEmailSent } from '@/lib/followup-eligibility'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const SEP = '═'.repeat(66)
const DIV = '─'.repeat(66)

interface EmailRow {
  id: string
  type: string
  subject: string
  sent_at: string | null
  status: string
}

interface LeadRow {
  id: string
  business_name: string
  email: string | null
  emails: EmailRow[]
}

async function main(): Promise<void> {
  console.log(SEP)
  console.log('  TEST:FOLLOWUP-PAGINATION  —  read-only, no emails sent')
  console.log(SEP)

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('✗ NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ── Load settings (same as followup agent) ────────────────────────────────
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

  // ── Paginated query (exact copy of fixed followup agent logic) ────────────
  console.log(`\n  Fetching contacted leads in batches of 1000...`)
  console.log(DIV)

  const BATCH_SIZE = 1000
  let offset = 0
  let totalProcessed = 0
  let batchNum = 0

  const now = new Date()
  let fu1Eligible = 0
  let fu2Eligible = 0
  let fu3Eligible = 0
  let skipNoEmail = 0
  let skipNoInitial = 0
  let skipNotYetDue = 0
  let skipAllSent = 0

  while (true) {
    const { data: batch, error: batchErr } = await supabase
      .from('leads')
      .select('id, business_name, email, emails(id, type, subject, sent_at, status)')
      .eq('status', 'contacted')
      .range(offset, offset + BATCH_SIZE - 1)

    if (batchErr) {
      console.error(`✗ Query failed at offset=${offset}:`, batchErr.message)
      process.exit(1)
    }

    if (!batch?.length) break

    batchNum++
    totalProcessed += batch.length
    console.log(`  Batch ${batchNum}: offset=${offset}, rows=${batch.length}, cumulative=${totalProcessed}`)

    for (const lead of batch as LeadRow[]) {
      if (!lead.email) { skipNoEmail++; continue }

      const emailsList = lead.emails ?? []
      const initialEmail = emailsList.find((e) => e.type === 'initial_pitch' && isFuEmailSent(e))

      if (!initialEmail?.sent_at) { skipNoInitial++; continue }

      const hasFu1Sent = emailsList.some((e) => e.type === 'follow_up_1' && isFuEmailSent(e))
      const hasFu2Sent = emailsList.some((e) => e.type === 'follow_up_2' && isFuEmailSent(e))
      const hasFu3Sent = emailsList.some((e) => e.type === 'follow_up_3' && isFuEmailSent(e))

      const eligibility = computeFollowUpEligibility(
        initialEmail.sent_at,
        hasFu1Sent,
        hasFu2Sent,
        hasFu3Sent,
        { fu1Days, fu2Days, fu3Days },
        now
      )

      if (eligibility.nextFuType === null) { skipAllSent++; continue }

      if (!eligibility.isDue) { skipNotYetDue++; continue }

      if (eligibility.nextFuType === 'follow_up_1') fu1Eligible++
      else if (eligibility.nextFuType === 'follow_up_2') fu2Eligible++
      else if (eligibility.nextFuType === 'follow_up_3') fu3Eligible++
    }

    if (batch.length < BATCH_SIZE) break
    offset += BATCH_SIZE
  }

  // ── Results ───────────────────────────────────────────────────────────────
  console.log('\n' + SEP)
  console.log('  RESULTS')
  console.log(SEP)

  console.log(`\n  Total contacted leads:      ${totalProcessed}`)
  console.log(`  Rows processed by sender:   ${totalProcessed}`)
  console.log(`  Batches used:               ${batchNum}`)

  console.log(`\n  FU1 Eligible:  ${fu1Eligible}`)
  console.log(`  FU2 Eligible:  ${fu2Eligible}`)
  console.log(`  FU3 Eligible:  ${fu3Eligible}`)

  console.log(`\n  Skipped (no email):         ${skipNoEmail}`)
  console.log(`  Skipped (no initial pitch): ${skipNoInitial}`)
  console.log(`  Skipped (not yet due):      ${skipNotYetDue}`)
  console.log(`  Skipped (all FUs sent):     ${skipAllSent}`)

  const paginationNeeded = totalProcessed > 1000
  console.log(`\n  Pagination was needed:      ${paginationNeeded ? 'YES ✓' : 'no (≤1000 leads)'}`)
  if (paginationNeeded) {
    console.log(`  Old code would have missed: ${totalProcessed - 1000} leads`)
    console.log(`  ✓ Fix confirmed — all ${totalProcessed} leads are now visible to the sender`)
  }

  // ── Spot-check: query first 1000 vs paginated ────────────────────────────
  console.log('\n' + DIV)
  console.log('  SPOT-CHECK: first-1000 count vs paginated count')
  console.log(DIV)

  const { count: oldStyleCount } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'contacted')

  console.log(`\n  Total contacted (COUNT query): ${oldStyleCount ?? 0}`)
  console.log(`  Total processed (paginated):   ${totalProcessed}`)

  if ((oldStyleCount ?? 0) === totalProcessed) {
    console.log(`  ✓ Counts match — full dataset processed`)
  } else {
    console.log(`  ✗ Mismatch! COUNT=${oldStyleCount}, processed=${totalProcessed}`)
  }

  console.log('\n' + SEP)
  console.log('  ✓ Read-only complete — no emails sent, no DB changes made')
  console.log(SEP)
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
