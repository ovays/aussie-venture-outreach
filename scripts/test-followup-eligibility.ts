/**
 * scripts/test-followup-eligibility.ts
 *
 * Diagnostic: shows exactly what the production follow-up sender would do
 * if it ran right now — which leads are eligible, which are skipped, and why.
 *
 * Uses the IDENTICAL query and eligibility functions as agents/followup.ts.
 * Read-only — no emails sent, no DB mutations.
 *
 * Run: npm run test:followup-eligibility
 */

import * as dotenv from 'dotenv'
import * as path from 'path'
import { createClient } from '@supabase/supabase-js'
import {
  computeFollowUpEligibility,
  isFuEmailSent,
  type FollowUpType,
} from '@/lib/followup-eligibility'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const SAMPLE_SIZE = 5
const SEP = '═'.repeat(62)
const DIV = '─'.repeat(62)

interface LeadEmail {
  id: string
  type: string
  subject: string | null
  sent_at: string | null
  status: string
}

interface ContactedLead {
  id: string
  business_name: string
  email: string | null
  emails: LeadEmail[]
}

interface Sample {
  name: string
  daysSince: number
  dueAtDays: number | null
  daysUntilDue: number | null
}

function printSamples(items: Sample[], mode: 'due' | 'pending'): void {
  if (!items.length) {
    console.log('  (none)')
    return
  }
  for (const s of items.slice(0, SAMPLE_SIZE)) {
    if (mode === 'due') {
      console.log(`  - ${s.name}  (${s.daysSince}d since pitch, due at ${s.dueAtDays}d)`)
    } else {
      console.log(`  - ${s.name}  (${s.daysSince}d since pitch, due in ${s.daysUntilDue}d)`)
    }
  }
  if (items.length > SAMPLE_SIZE) {
    console.log(`  … and ${items.length - SAMPLE_SIZE} more`)
  }
}

function printNameSamples(names: string[]): void {
  if (!names.length) {
    console.log('  (none)')
    return
  }
  for (const n of names.slice(0, SAMPLE_SIZE)) {
    console.log(`  - ${n}`)
  }
  if (names.length > SAMPLE_SIZE) {
    console.log(`  … and ${names.length - SAMPLE_SIZE} more`)
  }
}

async function main(): Promise<void> {
  console.log(SEP)
  console.log('  TEST:FOLLOWUP-ELIGIBILITY  —  read-only, no emails sent')
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

  // ── Settings — same keys as agents/followup.ts ────────────────────────────
  const { data: settingsRows, error: settingsErr } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', [
      'system_active',
      'follow_up_1_days',
      'follow_up_2_days',
      'follow_up_3_days',
    ])

  if (settingsErr) {
    console.error('✗ Failed to load settings:', settingsErr.message)
    process.exit(1)
  }

  const sm: Record<string, string> = {}
  for (const row of settingsRows ?? []) sm[row.key] = row.value

  const systemActive  = sm['system_active'] === 'true'
  const fu1Days       = parseInt(sm['follow_up_1_days'] ?? '7',  10)
  const fu2Days       = parseInt(sm['follow_up_2_days'] ?? '14', 10)
  const fu3Days       = parseInt(sm['follow_up_3_days'] ?? '21', 10)

  console.log(`\n  system_active      = ${systemActive}`)
  console.log(`  follow_up_1_days   = ${fu1Days}`)
  console.log(`  follow_up_2_days   = ${fu2Days}`)
  console.log(`  follow_up_3_days   = ${fu3Days}`)
  if (!systemActive) {
    console.log('\n  ⚠  system_active=false — production agent would exit immediately')
  }

  // ── Supplemental counts — leads the sender never queries ─────────────────
  const [{ count: repliedCount }, { count: deadCount }] = await Promise.all([
    supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'replied'),
    supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'dead'),
  ])

  // ── Paginated query + eligibility loop — IDENTICAL to agents/followup.ts ──
  const eligible: Record<FollowUpType, Sample[]> = {
    follow_up_1: [],
    follow_up_2: [],
    follow_up_3: [],
  }
  const notYetDue:     Sample[]  = []
  const skipNoInitial: string[]  = []
  const skipNoEmail:   string[]  = []
  const skipAllSent:   string[]  = []

  const now = new Date()
  const FU_BATCH_SIZE = 1000
  let fuOffset = 0
  let totalFetched = 0
  let batchesProcessed = 0

  console.log('\nQuerying contacted leads (paginated)…')

  while (true) {
    const { data: batch, error: batchErr } = await supabase
      .from('leads')
      .select('*, emails(id, type, subject, sent_at, status)')
      .eq('status', 'contacted')
      .range(fuOffset, fuOffset + FU_BATCH_SIZE - 1)

    if (batchErr) {
      console.error(`✗ Failed to query contacted leads (offset ${fuOffset}):`, batchErr.message)
      process.exit(1)
    }

    if (!batch?.length) break

    totalFetched += batch.length
    batchesProcessed++

    for (const lead of batch as ContactedLead[]) {
      // Step 1: skip leads with no email address
      if (!lead.email) {
        skipNoEmail.push(lead.business_name)
        continue
      }

      const emails           = lead.emails ?? []
      const initialPitchRows = emails.filter((e) => e.type === 'initial_pitch')
      const initialEmail     = initialPitchRows.find((e) => isFuEmailSent(e))

      // Step 2: skip leads with no sent initial_pitch email
      if (!initialEmail?.sent_at) {
        skipNoInitial.push(lead.business_name)
        continue
      }

      const hasFu1Sent = emails.some((e) => e.type === 'follow_up_1' && isFuEmailSent(e))
      const hasFu2Sent = emails.some((e) => e.type === 'follow_up_2' && isFuEmailSent(e))
      const hasFu3Sent = emails.some((e) => e.type === 'follow_up_3' && isFuEmailSent(e))

      // Step 3: compute eligibility using shared production function
      const eligibility = computeFollowUpEligibility(
        initialEmail.sent_at,
        hasFu1Sent,
        hasFu2Sent,
        hasFu3Sent,
        { fu1Days, fu2Days, fu3Days },
        now
      )

      // Step 4: all FUs sent — nothing left for this lead
      if (eligibility.nextFuType === null) {
        skipAllSent.push(lead.business_name)
        continue
      }

      const sample: Sample = {
        name:         lead.business_name,
        daysSince:    eligibility.daysSince,
        dueAtDays:    eligibility.dueAtDays,
        daysUntilDue: eligibility.daysUntilDue,
      }

      // Step 5: due today → eligible; not due → waiting
      if (eligibility.isDue) {
        eligible[eligibility.nextFuType].push(sample)
      } else {
        notYetDue.push(sample)
      }
    }

    if (batch.length < FU_BATCH_SIZE) break
    fuOffset += FU_BATCH_SIZE
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + SEP)
  console.log('  RESULTS  (mirrors production sender eligibility)')
  console.log(SEP)
  console.log('')
  console.log(`FU1 eligible today: ${eligible.follow_up_1.length}`)
  console.log(`FU2 eligible today: ${eligible.follow_up_2.length}`)
  console.log(`FU3 eligible today: ${eligible.follow_up_3.length}`)
  console.log('')
  console.log(`Skipped - not yet due:            ${notYetDue.length}`)
  console.log(`Skipped - no initial_pitch email: ${skipNoInitial.length}`)
  console.log(`Skipped - no email address:       ${skipNoEmail.length}`)
  console.log(`Skipped - all FUs sent:           ${skipAllSent.length}`)
  console.log('')
  console.log(`Skipped - replied: ${repliedCount ?? 0}  ← status='replied', sender never queries these`)
  console.log(`Skipped - dead:    ${deadCount ?? 0}  ← status='dead', sender never queries these`)
  console.log('')
  console.log(`Total contacted leads fetched: ${totalFetched}`)
  console.log(`Batches processed:            ${batchesProcessed}`)

  // ── Sample leads ──────────────────────────────────────────────────────────
  console.log('\n' + DIV)
  console.log('FU1 eligible:')
  printSamples(eligible.follow_up_1, 'due')

  console.log('\n' + DIV)
  console.log('FU2 eligible:')
  printSamples(eligible.follow_up_2, 'due')

  console.log('\n' + DIV)
  console.log('FU3 eligible:')
  printSamples(eligible.follow_up_3, 'due')

  console.log('\n' + DIV)
  console.log('Skipped - not yet due:')
  printSamples(notYetDue, 'pending')

  console.log('\n' + DIV)
  console.log('Skipped - no initial_pitch email:')
  printNameSamples(skipNoInitial)

  console.log('\n' + SEP)
  console.log('  ✓ Read-only complete — no emails sent, no DB changes made')
  console.log(SEP)
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
