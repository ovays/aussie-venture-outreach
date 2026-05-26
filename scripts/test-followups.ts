/**
 * scripts/test-followups.ts
 *
 * Dry-run simulation of the full follow-up pipeline.
 * Connects to real production DB, runs IDENTICAL eligibility/quota/queue logic
 * as the live agent, but sends NO emails and makes NO DB mutations.
 *
 * Run: npm run test:followups
 */

import * as dotenv from 'dotenv'
import * as path from 'path'
import { createClient } from '@supabase/supabase-js'
import { computeFollowUpEligibility, isFuEmailSent, type FollowUpType } from '@/lib/followup-eligibility'
import { getAnalyticsDayRange } from '@/lib/analytics'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const DRY_RUN = true

// ── Types (mirrors agents/followup.ts) ───────────────────────────────────────

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

interface FollowUpCandidate {
  lead: ContactedLead
  initialEmail: LeadEmail
  daysSince: number
}

// ── Settings keys (mirrors agents/followup.ts) ────────────────────────────────

const FOLLOW_UP_LIMIT_KEYS: Record<FollowUpType, string> = {
  follow_up_1: 'daily_followup1_limit',
  follow_up_2: 'daily_followup2_limit',
  follow_up_3: 'daily_followup3_limit',
}

const FOLLOW_UP_DEFAULT_LIMITS: Record<FollowUpType, number> = {
  follow_up_1: 20,
  follow_up_2: 10,
  follow_up_3: 5,
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(66))
  console.log('  TEST-FOLLOWUPS — DRY RUN — no emails, no DB writes')
  console.log(`  DRY_RUN = ${DRY_RUN}`)
  console.log('═'.repeat(66))

  // ── Env validation ────────────────────────────────────────────────────────
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('✗ NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — aborting')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ── Load settings (same keys as production agent) ─────────────────────────
  const { data: settingsRows, error: settingsErr } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', [
      'system_active',
      'follow_up_1_days',
      'follow_up_2_days',
      'follow_up_3_days',
      'dead_lead_days',
      'daily_lead_limit',
      'daily_followup1_limit',
      'daily_followup2_limit',
      'daily_followup3_limit',
      'reactivation_enabled',
    ])

  if (settingsErr) {
    console.error('✗ Failed to load settings:', settingsErr.message)
    process.exit(1)
  }

  const sm: Record<string, string> = {}
  for (const row of settingsRows ?? []) sm[row.key] = row.value

  const systemActive       = sm['system_active'] === 'true'
  const reactivationEnabled = sm['reactivation_enabled'] === 'true'
  const followUp1Days      = parseInt(sm['follow_up_1_days'] ?? '7', 10)
  const followUp2Days      = parseInt(sm['follow_up_2_days'] ?? '14', 10)
  const followUp3Days      = parseInt(sm['follow_up_3_days'] ?? '21', 10)
  const configuredGlobalLimit = parseInt(sm['daily_lead_limit'] ?? '100', 10)

  const limits: Record<FollowUpType, number> = {
    follow_up_1: parseInt(sm[FOLLOW_UP_LIMIT_KEYS.follow_up_1] ?? String(FOLLOW_UP_DEFAULT_LIMITS.follow_up_1), 10),
    follow_up_2: parseInt(sm[FOLLOW_UP_LIMIT_KEYS.follow_up_2] ?? String(FOLLOW_UP_DEFAULT_LIMITS.follow_up_2), 10),
    follow_up_3: parseInt(sm[FOLLOW_UP_LIMIT_KEYS.follow_up_3] ?? String(FOLLOW_UP_DEFAULT_LIMITS.follow_up_3), 10),
  }

  // ── Today's range and global sent count ───────────────────────────────────
  const today = getAnalyticsDayRange()

  const { count: alreadySentToday } = await supabase
    .from('emails')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'sent')
    .in('type', ['initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3'])
    .gte('sent_at', today.start)
    .lt('sent_at', today.end)

  async function sentTodayCount(type: FollowUpType): Promise<number> {
    const { count } = await supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'sent')
      .eq('type', type)
      .gte('sent_at', today.start)
      .lt('sent_at', today.end)
    return count ?? 0
  }

  const sentBeforeRun: Record<FollowUpType, number> = {
    follow_up_1: await sentTodayCount('follow_up_1'),
    follow_up_2: await sentTodayCount('follow_up_2'),
    follow_up_3: await sentTodayCount('follow_up_3'),
  }

  const remainingGlobalToday = Math.max(0, configuredGlobalLimit - (alreadySentToday ?? 0))

  const fu1SentToday = sentBeforeRun.follow_up_1
  const fu2SentToday = sentBeforeRun.follow_up_2
  const fu3SentToday = sentBeforeRun.follow_up_3

  const remaining: Record<FollowUpType, number> = {
    follow_up_1: Math.max(0, limits.follow_up_1 - fu1SentToday),
    follow_up_2: Math.max(0, limits.follow_up_2 - fu2SentToday),
    follow_up_3: Math.max(0, limits.follow_up_3 - fu3SentToday),
  }

  console.log('[FU_QUOTA_DEBUG]', {
    fu1_limit:               limits.follow_up_1,
    fu1_sent_today:          fu1SentToday,
    fu1_remaining:           remaining.follow_up_1,
    fu2_limit:               limits.follow_up_2,
    fu2_sent_today:          fu2SentToday,
    fu2_remaining:           remaining.follow_up_2,
    fu3_limit:               limits.follow_up_3,
    fu3_sent_today:          fu3SentToday,
    fu3_remaining:           remaining.follow_up_3,
    configured_global_limit: configuredGlobalLimit,
    already_sent_today:      alreadySentToday ?? 0,
    remaining_global_today:  remainingGlobalToday,
  })

  // ── Quota summary ─────────────────────────────────────────────────────────
  console.log('\n── Quota Summary ─────────────────────────────────────────────────')
  console.log(`system_active              = ${systemActive}`)
  console.log(`reactivation_enabled       = ${reactivationEnabled}`)
  console.log(`configuredGlobalLimit      = ${configuredGlobalLimit}`)
  console.log(`alreadySentToday           = ${alreadySentToday ?? 0}`)
  console.log(`remainingGlobalToday       = ${remainingGlobalToday}`)
  console.log(`FU1_LIMIT                  = ${limits.follow_up_1}  (sent: ${sentBeforeRun.follow_up_1}, remaining: ${remaining.follow_up_1})`)
  console.log(`FU2_LIMIT                  = ${limits.follow_up_2}  (sent: ${sentBeforeRun.follow_up_2}, remaining: ${remaining.follow_up_2})`)
  console.log(`FU3_LIMIT                  = ${limits.follow_up_3}  (sent: ${sentBeforeRun.follow_up_3}, remaining: ${remaining.follow_up_3})`)
  console.log(`follow_up_1_days           = ${followUp1Days}`)
  console.log(`follow_up_2_days           = ${followUp2Days}`)
  console.log(`dead_lead_days (fu3 gate)  = ${followUp3Days}`)
  console.log(`today_range                = ${today.start} → ${today.end}`)

  if (!systemActive) {
    console.log('\n[DRY_RUN] system_active=false — agent would exit immediately')
    return
  }

  // ── Load contacted leads (same query as production) ───────────────────────
  console.log('\n── Loading contacted leads… ──────────────────────────────────────')
  const { data: contactedLeads, error: contactedLeadsErr } = await supabase
    .from('leads')
    .select('*, emails(id, type, subject, sent_at, status)')
    .eq('status', 'contacted')

  if (contactedLeadsErr) {
    console.error('✗ Failed to query contacted leads:', contactedLeadsErr.message)
    process.exit(1)
  }

  console.log(`Contacted leads fetched: ${contactedLeads?.length ?? 0}`)

  if (!contactedLeads?.length) {
    console.log('[DRY_RUN] No contacted leads — nothing to send')
    return
  }

  // ── Eligibility loop (identical logic to production, read-only) ───────────
  const queues: Record<FollowUpType, FollowUpCandidate[]> = {
    follow_up_1: [],
    follow_up_2: [],
    follow_up_3: [],
  }

  let wouldMarkDead   = 0
  let skipNoEmail     = 0
  let skipNoInitial   = 0
  let skipNotYetDue   = 0
  let skipAllSent     = 0

  const now = new Date()

  console.log('\n── Per-lead eligibility [FU_CHECK] ───────────────────────────────')

  for (const lead of contactedLeads as ContactedLead[]) {
    if (!lead.email) {
      skipNoEmail++
      continue
    }

    const emailsList = lead.emails ?? []
    const initialPitchRows = emailsList.filter((e) => e.type === 'initial_pitch')
    const initialEmail = initialPitchRows.find((e) => isFuEmailSent(e))

    if (!initialEmail?.sent_at) {
      skipNoInitial++
      console.log('[FU_CHECK]', {
        leadId:      lead.id,
        businessName: lead.business_name,
        skipReason:  'no_initial_sent',
        pitchRows:   initialPitchRows.map((e) => ({ status: e.status, sent_at: e.sent_at })),
      })
      continue
    }

    const hasFu1Sent = emailsList.some((e) => e.type === 'follow_up_1' && isFuEmailSent(e))
    const hasFu2Sent = emailsList.some((e) => e.type === 'follow_up_2' && isFuEmailSent(e))
    const hasFu3Sent = emailsList.some((e) => e.type === 'follow_up_3' && isFuEmailSent(e))

    const eligibility = computeFollowUpEligibility(
      initialEmail.sent_at,
      hasFu1Sent,
      hasFu2Sent,
      hasFu3Sent,
      { fu1Days: followUp1Days, fu2Days: followUp2Days, fu3Days: followUp3Days },
      now
    )

    // All FUs sent — check for dead-marking (dry-run: log only, no DB write)
    if (eligibility.nextFuType === null) {
      const fu3Email = emailsList.find((e) => e.type === 'follow_up_3' && isFuEmailSent(e))
      if (
        !reactivationEnabled &&
        fu3Email?.sent_at &&
        fu3Email.sent_at < today.start &&
        eligibility.daysSince >= followUp3Days
      ) {
        console.log('[FU_CHECK]', {
          leadId:      lead.id,
          businessName: lead.business_name,
          nextFuType:  null,
          daysSince:   eligibility.daysSince,
          skipReason:  'would_mark_dead',
        })
        wouldMarkDead++
        continue
      }
      skipAllSent++
      console.log('[FU_CHECK]', {
        leadId:      lead.id,
        businessName: lead.business_name,
        nextFuType:  null,
        daysSince:   eligibility.daysSince,
        skipReason:  'all_fu_sent',
      })
      continue
    }

    const skipReason = eligibility.isDue ? 'eligible' : 'not_yet_due'

    console.log('[FU_CHECK]', {
      leadId:       lead.id,
      businessName: lead.business_name,
      nextFuType:   eligibility.nextFuType,
      daysSince:    eligibility.daysSince,
      dueAtDays:    eligibility.dueAtDays,
      daysUntilDue: eligibility.daysUntilDue,
      isDue:        eligibility.isDue,
      skipReason,
    })

    if (eligibility.isDue) {
      queues[eligibility.nextFuType].push({ lead, initialEmail, daysSince: eligibility.daysSince })
    } else {
      skipNotYetDue++
    }
  }

  // ── Phase B: Independent allocation, then single global cap ─────────────
  // Each queue gets min(eligible, queueLimit) independently — no competition.
  // One final global cap applied afterwards via budget trimming (fu1 → fu2 → fu3).
  const allocation: Record<FollowUpType, number> = {
    follow_up_1: Math.min(queues.follow_up_1.length, limits.follow_up_1),
    follow_up_2: Math.min(queues.follow_up_2.length, limits.follow_up_2),
    follow_up_3: Math.min(queues.follow_up_3.length, limits.follow_up_3),
  }

  const totalRequested = allocation.follow_up_1 + allocation.follow_up_2 + allocation.follow_up_3
  const finalAllocation: Record<FollowUpType, number> = { ...allocation }

  if (totalRequested > remainingGlobalToday) {
    let budget = remainingGlobalToday
    for (const type of ['follow_up_1', 'follow_up_2', 'follow_up_3'] as const) {
      const take = Math.min(finalAllocation[type], budget)
      finalAllocation[type] = take
      budget -= take
    }
  }

  const finalTotal = finalAllocation.follow_up_1 + finalAllocation.follow_up_2 + finalAllocation.follow_up_3
  const skippedByGlobalCap = (allocation.follow_up_1 - finalAllocation.follow_up_1)
                           + (allocation.follow_up_2 - finalAllocation.follow_up_2)
                           + (allocation.follow_up_3 - finalAllocation.follow_up_3)

  console.log('\n[OUTBOUND_ALLOCATION]', {
    configuredGlobalLimit,
    alreadySentToday:    alreadySentToday ?? 0,
    remainingGlobalToday,
    allocation,
    totalRequested,
    finalAllocation,
    finalTotal,
  })

  const selectedByType: Record<FollowUpType, FollowUpCandidate[]> = {
    follow_up_1: queues.follow_up_1.slice(0, finalAllocation.follow_up_1),
    follow_up_2: queues.follow_up_2.slice(0, finalAllocation.follow_up_2),
    follow_up_3: queues.follow_up_3.slice(0, finalAllocation.follow_up_3),
  }

  for (const type of ['follow_up_1', 'follow_up_2', 'follow_up_3'] as const) {
    const fuLabel = type === 'follow_up_1' ? 'FU1' : type === 'follow_up_2' ? 'FU2' : 'FU3'
    console.log(`\n[${fuLabel}_DEBUG]`, {
      eligible:       queues[type].length,
      limit:          limits[type],
      sentToday:      sentBeforeRun[type],
      allocated:      allocation[type],
      finalAllocated: finalAllocation[type],
    })
  }

  // ── Dry-run send log ──────────────────────────────────────────────────────
  console.log('\n── [DRY_RUN] Would send ──────────────────────────────────────────')
  for (const type of ['follow_up_1', 'follow_up_2', 'follow_up_3'] as const) {
    for (const c of selectedByType[type]) {
      console.log('[DRY_RUN] Would send', {
        leadId:       c.lead.id,
        businessName: c.lead.business_name,
        email:        c.lead.email,
        type,
        daysSince:    c.daysSince,
      })
const preview =
  type === 'follow_up_1'
    ? `
Subject: Quick follow-up from Aussie Venture

Hi ${c.lead.business_name},

Just wanted to reach out once more as we’d still love to explore a possible collaboration with you.

We work with Aussie food and travel audiences across social platforms and thought your business could be a great fit for some authentic exposure.

No pressure at all — if it’s something you’d be open to discussing, we’d be happy to share a few ideas.

Thanks again and hope you have a great week.

– Aussie Venture
`
    : type === 'follow_up_2'
    ? `
Subject: Collaboration opportunity with Aussie Venture

Hi ${c.lead.business_name},

Thought I’d send one more quick follow-up as we’d still genuinely love to feature your business.

We’ve worked with a range of venues and experiences across Sydney and always aim to create content that feels natural and valuable for both sides.

Completely understand timing can get busy, but if collaborations are something you’re open to, we’d be happy to chat further whenever convenient.

Appreciate your time either way.

– Aussie Venture
`
    : `
Subject: Keeping the door open

Hi ${c.lead.business_name},

Just wanted to send a final quick note and say thanks for taking the time to read our earlier messages.

No worries at all if the timing isn’t right at the moment — we’d still be happy to connect in the future if collaboration opportunities come up down the track.

Wishing you and the team all the best.

– Aussie Venture
`

console.log(`
----- EMAIL PREVIEW -----

${preview}

-------------------------
`)

    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalSelected = selectedByType.follow_up_1.length + selectedByType.follow_up_2.length + selectedByType.follow_up_3.length

  console.log('\n── [FU_SUMMARY] ──────────────────────────────────────────────────')
  console.log(`eligibleFU1       = ${queues.follow_up_1.length}`)
  console.log(`eligibleFU2       = ${queues.follow_up_2.length}`)
  console.log(`eligibleFU3       = ${queues.follow_up_3.length}`)
  console.log(`selectedFU1       = ${selectedByType.follow_up_1.length}`)
  console.log(`selectedFU2       = ${selectedByType.follow_up_2.length}`)
  console.log(`selectedFU3       = ${selectedByType.follow_up_3.length}`)
  console.log(`skippedNotDue     = ${skipNotYetDue}`)
  console.log(`skippedNoInitial  = ${skipNoInitial}`)
  console.log(`skippedNoEmail    = ${skipNoEmail}`)
  console.log(`skippedAllSent    = ${skipAllSent}`)
  console.log(`skippedReplied    = 0  (excluded upstream by lead status)`)
  console.log(`skippedGlobalCap  = ${skippedByGlobalCap}`)
  console.log(`wouldMarkDead     = ${wouldMarkDead}`)
  console.log(`\nFINAL TOTAL OUTBOUND  = ${totalSelected}`)
  console.log(`REMAINING_GLOBAL_TODAY left = ${remainingGlobalToday - finalTotal}`)

  // ── Validation ────────────────────────────────────────────────────────────
  if (totalSelected > configuredGlobalLimit) {
    throw new Error(`[VALIDATION FAILED] Global cap exceeded: selected ${totalSelected} > configuredGlobalLimit ${configuredGlobalLimit}`)
  }
  if (totalSelected > remainingGlobalToday) {
    throw new Error(`[VALIDATION FAILED] Selected (${totalSelected}) exceeds remainingGlobalToday (${remainingGlobalToday})`)
  }

  console.log('\n✓ Validation passed — cap not exceeded')
  console.log('✓ DRY RUN complete — no emails sent, no DB changes made')
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
