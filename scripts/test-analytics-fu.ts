import * as dotenv from 'dotenv'
import * as path from 'path'
import { createClient } from '@supabase/supabase-js'
import { getFollowupStats } from '@/lib/analytics'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
})

import { computeFollowUpEligibility, isFuEmailSent } from '@/lib/followup-eligibility'

async function main() {
  // Pull the same settings and leads that analytics uses
  const [{ data: settingsRows }, { data: contactedLeads }] = await Promise.all([
    supabase
      .from('settings')
      .select('key, value')
      .in('key', ['follow_up_1_days', 'follow_up_2_days', 'follow_up_3_days', 'dead_lead_days', 'reactivation_delay_days', 'dead_after_reactivation_days', 'reactivation_enabled']),
    supabase
      .from('leads')
      .select('id, status, email, reactivation_sent_at, emails(id, lead_id, type, status, sent_at, replied_at)')
      .in('status', ['contacted']),
  ])

  const sm: Record<string, string> = {}
  for (const row of settingsRows ?? []) sm[row.key] = row.value

  const fu1Days = parseInt(sm['follow_up_1_days'] ?? '7', 10)
  const fu2Days = parseInt(sm['follow_up_2_days'] ?? '14', 10)
  const fu3Days = parseInt(sm['follow_up_3_days'] ?? '21', 10)
  const reactivationDelayDays = parseInt(sm['reactivation_delay_days'] ?? '60', 10)
  const deadAfterReactivationDays = parseInt(sm['dead_after_reactivation_days'] ?? '14', 10)
  const reactivationEnabled = sm['reactivation_enabled'] === 'true'

  console.log('Settings:', { fu1Days, fu2Days, fu3Days, reactivationDelayDays, deadAfterReactivationDays, reactivationEnabled })
  console.log('Total leads from DB:', (contactedLeads ?? []).length)
  console.log()

  const now = new Date()
  let skipped_no_email = 0, skipped_no_initial = 0, skipped_reactivated = 0
  let bucket_fu1_due = 0, bucket_fu1_not_due = 0
  let bucket_fu2_due = 0, bucket_fu2_not_due = 0
  let bucket_fu3_due = 0, bucket_fu3_not_due = 0
  let bucket_null_reactivation = 0, bucket_null_dead = 0

  for (const lead of (contactedLeads ?? []) as any[]) {
    if (!lead.email) { skipped_no_email++; continue }
    const emails = (lead.emails ?? []) as any[]
    const initialEmail = emails.find((e: any) => e.type === 'initial_pitch' && e.sent_at)
    if (!initialEmail?.sent_at) { skipped_no_initial++; continue }

    const fu1Sent = emails.some((e: any) => e.type === 'follow_up_1' && e.sent_at !== null)
    const fu2Sent = emails.some((e: any) => e.type === 'follow_up_2' && e.sent_at !== null)
    const fu3Sent = emails.some((e: any) => e.type === 'follow_up_3' && e.sent_at !== null)

    const eligibility = computeFollowUpEligibility(
      initialEmail.sent_at, fu1Sent, fu2Sent, fu3Sent,
      { fu1Days, fu2Days, fu3Days }, now
    )

    if (lead.reactivation_sent_at) {
      skipped_reactivated++
      continue
    }

    if (eligibility.nextFuType === 'follow_up_1') {
      if (eligibility.isDue) bucket_fu1_due++; else bucket_fu1_not_due++
    } else if (eligibility.nextFuType === 'follow_up_2') {
      if (eligibility.isDue) bucket_fu2_due++; else bucket_fu2_not_due++
    } else if (eligibility.nextFuType === 'follow_up_3') {
      if (eligibility.isDue) bucket_fu3_due++; else bucket_fu3_not_due++
    } else if (eligibility.nextFuType === null) {
      if (reactivationEnabled) bucket_null_reactivation++; else bucket_null_dead++
    }
  }

  console.log('── Skips ────────────────────────────────────')
  console.log('  no email         :', skipped_no_email)
  console.log('  no initial pitch :', skipped_no_initial)
  console.log('  reactivated      :', skipped_reactivated)
  console.log()
  console.log('── FU1 stage ────────────────────────────────')
  console.log('  isDue=true       :', bucket_fu1_due)
  console.log('  isDue=false      :', bucket_fu1_not_due)
  console.log()
  console.log('── FU2 stage ────────────────────────────────')
  console.log('  isDue=true       :', bucket_fu2_due)
  console.log('  isDue=false      :', bucket_fu2_not_due)
  console.log()
  console.log('── FU3 stage ────────────────────────────────')
  console.log('  isDue=true       :', bucket_fu3_due, '  ← analytics fu3Due')
  console.log('  isDue=false      :', bucket_fu3_not_due)
  console.log()
  console.log('── All FUs sent (null) ──────────────────────')
  console.log('  reactivation     :', bucket_null_reactivation)
  console.log('  dead path        :', bucket_null_dead)
  console.log()
  console.log('── Summary (analytics client) ───────────────')
  console.log('  fu1Due           :', bucket_fu1_due)
  console.log('  fu2Due           :', bucket_fu2_due)
  console.log('  fu3Due           :', bucket_fu3_due)
  console.log('  fuDue            :', bucket_fu1_due + bucket_fu2_due + bucket_fu3_due)
}

main().catch((err) => { console.error(err); process.exit(1) })
