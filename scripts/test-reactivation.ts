/**
 * test-reactivation.ts
 *
 * Dry-run tester for reactivation lifecycle logic.
 * Evaluates each contacted lead against reactivation/dead-after-reactivation rules
 * and prints exactly what the real agent would do — without touching the DB.
 *
 * Run:  npm run test:reactivation
 *       npm run test:reactivation -- --days=65
 *       npm run test:reactivation -- --days=65 --limit=5
 *
 * --days=N   Simulate all leads as if N days have passed since initial outreach.
 *            Does not affect days-since-reactivation (always uses real timestamp).
 * --limit=N  Max leads to evaluate (default: 20).
 */

import * as dotenv from 'dotenv'
import * as path from 'path'
import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

function getArgNum(name: string, fallback: number): number {
  const arg = args.find((a) => a.startsWith(`--${name}=`))
  if (!arg) return fallback
  const n = parseInt(arg.split('=')[1], 10)
  return isNaN(n) ? fallback : n
}

const DAY_OVERRIDE: number | null = (() => {
  const arg = args.find((a) => a.startsWith('--days='))
  if (!arg) return null
  const n = parseInt(arg.split('=')[1], 10)
  return isNaN(n) ? null : n
})()

const LIMIT = getArgNum('limit', 20)

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysSince(isoDate: string): number {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86_400_000)
}

function fmt(isoDate: string | null | undefined): string {
  if (!isoDate) return 'null'
  return isoDate.slice(0, 10)
}

const SEP = '═'.repeat(56)
const DIV = '─'.repeat(56)

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(SEP)
  console.log('  TEST-REACTIVATION  —  DRY RUN (no DB writes)')
  if (DAY_OVERRIDE !== null) {
    console.log(`  Simulating days_since_initial = ${DAY_OVERRIDE} for all leads`)
  }
  console.log(`  Limit: ${LIMIT} contacted leads`)
  console.log(SEP)

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    console.error('\n✗ NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — aborting')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // ── Load settings ──────────────────────────────────────────────────────────
  const { data: settingsRows, error: settingsErr } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', [
      'reactivation_enabled',
      'reactivation_delay_days',
      'dead_after_reactivation_days',
      'follow_up_1_days',
      'follow_up_2_days',
      'dead_lead_days',
    ])

  if (settingsErr) {
    console.error('✗ Failed to load settings:', settingsErr.message)
    process.exit(1)
  }

  const settingsMap: Record<string, string> = {}
  for (const row of settingsRows ?? []) settingsMap[row.key] = row.value

  const reactivationEnabled  = settingsMap['reactivation_enabled'] === 'true'
  const reactivationDelayDays      = parseInt(settingsMap['reactivation_delay_days']      ?? '60', 10)
  const deadAfterReactivationDays  = parseInt(settingsMap['dead_after_reactivation_days'] ?? '14', 10)
  const followUp1Days              = parseInt(settingsMap['follow_up_1_days']             ?? '7',  10)
  const followUp2Days              = parseInt(settingsMap['follow_up_2_days']             ?? '14', 10)
  const deadLeadDays               = parseInt(settingsMap['dead_lead_days']               ?? '21', 10)

  console.log('\nSettings loaded from DB:')
  console.log(`  reactivation_enabled         = ${reactivationEnabled}`)
  console.log(`  reactivation_delay_days      = ${reactivationDelayDays}`)
  console.log(`  dead_after_reactivation_days = ${deadAfterReactivationDays}`)
  console.log(`  follow_up_1_days             = ${followUp1Days}`)
  console.log(`  follow_up_2_days             = ${followUp2Days}`)
  console.log(`  dead_lead_days               = ${deadLeadDays}  (FU3 threshold)`)

  if (!reactivationEnabled) {
    console.log('\n⚠  reactivation_enabled = false')
    console.log('   Real agent would exit immediately. Evaluating hypothetically below.')
  }

  // ── Safety note ────────────────────────────────────────────────────────────
  console.log('\nSafety filters (real agent):')
  console.log('  Only status=contacted leads are processed')
  console.log('  Dead / blocked / invalid / non-halal-rejected leads are never reached')
  console.log('  Leads without follow_up_2 are ineligible')
  console.log('  Leads with reactivation_sent_at set skip to dead-after-reactivation check')

  // ── Fetch contacted leads ──────────────────────────────────────────────────
  const { data: leads, error: leadsErr } = await supabase
    .from('leads')
    .select('id, business_name, email, status, created_at, reactivation_sent_at, emails(type, sent_at)')
    .eq('status', 'contacted')
    .order('created_at', { ascending: true })
    .limit(LIMIT)

  if (leadsErr) {
    console.error('\n✗ Failed to fetch leads:', leadsErr.message)
    process.exit(1)
  }

  if (!leads?.length) {
    console.log('\nNo contacted leads found in DB.')
    return
  }

  console.log(`\nFetched ${leads.length} contacted lead(s)\n`)

  // ── Per-lead evaluation ────────────────────────────────────────────────────
  let wouldSendCount   = 0
  let wouldDeadCount   = 0
  let notEligibleCount = 0

  for (const lead of leads) {
    const emails: Array<{ type: string; sent_at: string | null }> = (lead.emails as Array<{ type: string; sent_at: string | null }>) ?? []

    const initialEmail = emails.find((e) => e.type === 'initial_pitch' && e.sent_at)
    const hasFU1       = emails.some((e) => e.type === 'follow_up_1' && e.sent_at)
    const hasFU2       = emails.some((e) => e.type === 'follow_up_2' && e.sent_at)
    const hasFU3       = emails.some((e) => e.type === 'follow_up_3' && e.sent_at)
    const hasReact     = emails.some((e) => e.type === 'reactivation' && e.sent_at)

    const actualDaysSinceInitial = initialEmail?.sent_at ? daysSince(initialEmail.sent_at) : null
    const effectiveDays = DAY_OVERRIDE ?? actualDaysSinceInitial

    const reactivationSentAt = lead.reactivation_sent_at as string | null
    const daysSinceReact = reactivationSentAt ? daysSince(reactivationSentAt) : null

    console.log(SEP)
    console.log(`[TEST_REACTIVATION] lead=${lead.business_name}`)
    console.log(DIV)
    console.log(`  id                  : ${lead.id}`)
    console.log(`  email               : ${lead.email ?? '(none)'}`)
    console.log(`  status              : ${lead.status}`)
    console.log(`  initial_pitch       : ${fmt(initialEmail?.sent_at)}`)
    console.log(`  days_since_initial  : ${effectiveDays !== null ? effectiveDays : '(no initial email)'}${DAY_OVERRIDE !== null ? '  ← simulated' : ''}`)
    console.log(`  follow_up_1         : ${hasFU1 ? 'yes' : 'no'}`)
    console.log(`  follow_up_2         : ${hasFU2 ? 'yes' : 'no'}`)
    console.log(`  follow_up_3         : ${hasFU3 ? 'yes' : 'no'}`)
    console.log(`  reactivation email  : ${hasReact ? 'yes (emails table)' : 'no'}`)
    console.log(`  reactivation_sent_at: ${fmt(reactivationSentAt)}`)
    if (daysSinceReact !== null) {
      console.log(`  days_since_react    : ${daysSinceReact}`)
    }

    console.log('')

    // ── Safety: no initial email ─────────────────────────────────────────────
    if (!initialEmail?.sent_at) {
      console.log('  [REACTIVATION_NOT_ELIGIBLE] reason=no_initial_email')
      notEligibleCount++
      continue
    }

    if (effectiveDays === null) {
      console.log('  [REACTIVATION_NOT_ELIGIBLE] reason=cannot_determine_days')
      notEligibleCount++
      continue
    }

    // ── Dead-after-reactivation path ─────────────────────────────────────────
    if (reactivationSentAt) {
      if (daysSinceReact! >= deadAfterReactivationDays) {
        console.log(`  [WOULD_MARK_DEAD]`)
        console.log(`  days_since_reactivation = ${daysSinceReact} >= dead_after_reactivation_days = ${deadAfterReactivationDays}`)
        console.log(`  WOULD_SET status=dead`)
        wouldDeadCount++
      } else {
        const remaining = deadAfterReactivationDays - daysSinceReact!
        console.log(`  [REACTIVATION_NOT_ELIGIBLE] reason=already_reactivated_awaiting_dead_window`)
        console.log(`  days_until_dead = ${remaining}  (need ${deadAfterReactivationDays - daysSinceReact!} more day(s))`)
        notEligibleCount++
      }
      continue
    }

    // ── Reactivation eligibility path ────────────────────────────────────────
    if (!hasFU2) {
      console.log(`  [REACTIVATION_NOT_ELIGIBLE] reason=follow_up_2_not_completed`)
      notEligibleCount++
      continue
    }

    if (effectiveDays >= reactivationDelayDays) {
      console.log(`  [REACTIVATION_ELIGIBLE]`)
      console.log(`  days_since_initial = ${effectiveDays} >= reactivation_delay_days = ${reactivationDelayDays}`)
      if (!reactivationEnabled) {
        console.log(`  ⚠  reactivation_enabled=false — real agent would skip`)
        console.log(`  WOULD_SEND_REACTIVATION = false  (disabled in settings)`)
      } else {
        console.log(`  WOULD_SEND_REACTIVATION = true`)
      }
      wouldSendCount++
    } else {
      const remaining = reactivationDelayDays - effectiveDays
      console.log(`  [REACTIVATION_NOT_ELIGIBLE] reason=too_soon`)
      console.log(`  days_since_initial = ${effectiveDays}, need ${reactivationDelayDays} (${remaining} more day(s))`)
      notEligibleCount++
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + SEP)
  console.log('SUMMARY')
  console.log(DIV)
  console.log(`  Total evaluated         : ${leads.length}`)
  console.log(`  [REACTIVATION_ELIGIBLE] : ${wouldSendCount}`)
  console.log(`  [WOULD_MARK_DEAD]       : ${wouldDeadCount}`)
  console.log(`  [NOT_ELIGIBLE]          : ${notEligibleCount}`)
  console.log('')
  if (DAY_OVERRIDE !== null) {
    console.log(`  ⚙  All leads simulated at days_since_initial = ${DAY_OVERRIDE}`)
  }
  if (!reactivationEnabled) {
    console.log('  ⚠  reactivation_enabled = false — real agent does nothing')
    console.log('     Enable in dashboard (Settings > Reactivation Settings)')
  }
  console.log(SEP)
  console.log('')
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
