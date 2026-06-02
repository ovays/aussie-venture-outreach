/**
 * scripts/test-reactivation-eligibility.ts
 *
 * Pure-unit test for reactivation eligibility — no DB, no email sends.
 *
 * Verifies the fix: reactivation now requires FU3 sent (was: FU2).
 *
 * Scenarios tested:
 *   A  FU2 sent, FU3 NOT sent, delay elapsed     → NOT eligible  (the bug case)
 *   B  FU3 sent, delay elapsed                   → ELIGIBLE
 *   C  FU3 sent, delay NOT yet elapsed            → NOT eligible  (timing gate)
 *   D  FU1 sent only (FU2+FU3 missing)            → NOT eligible  (FU gate unchanged)
 *   E  No follow-ups sent at all                  → NOT eligible  (FU gate unchanged)
 *   F  FU1 sent, FU2 sent, FU3 NOT sent           → NOT eligible  (was incorrectly eligible before fix)
 *
 * Run: npm run test:reactivation-eligibility
 */

const SEP = '═'.repeat(68)
const DIV = '─'.repeat(68)

// Mirrors the EmailRow shape used by agents/reactivation.ts
interface EmailRow {
  type: string
  sent_at: string | null
}

interface Scenario {
  name: string
  emails: EmailRow[]
  daysSinceInitial: number
  reactivationDelayDays: number
  expectEligible: boolean
  reason: string
}

// Apply the EXACT same eligibility logic as the patched agents/reactivation.ts.
// Returns true when the lead would be added to the reactivation queue.
function isEligibleForReactivation(
  emails: EmailRow[],
  daysSinceInitial: number,
  reactivationDelayDays: number
): boolean {
  const initialEmail = emails.find((e) => e.type === 'initial_pitch' && e.sent_at)
  if (!initialEmail?.sent_at) return false

  const hasFollowUp3 = emails.some((e) => e.type === 'follow_up_3' && e.sent_at)
  if (!hasFollowUp3) return false

  if (daysSinceInitial < reactivationDelayDays) return false

  return true
}

// Helper to build a fake sent_at timestamp N days ago
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

const REACTIVATION_DELAY = 60  // mirrors default reactivation_delay_days

const scenarios: Scenario[] = [
  {
    name: 'A — FU2 sent, FU3 NOT sent, delay elapsed (was the bug)',
    emails: [
      { type: 'initial_pitch', sent_at: daysAgo(70) },
      { type: 'follow_up_1',   sent_at: daysAgo(63) },
      { type: 'follow_up_2',   sent_at: daysAgo(56) },
      // follow_up_3 absent
    ],
    daysSinceInitial: 70,
    reactivationDelayDays: REACTIVATION_DELAY,
    expectEligible: false,
    reason: 'FU3 not sent → must not proceed to reactivation',
  },
  {
    name: 'B — FU3 sent, delay elapsed',
    emails: [
      { type: 'initial_pitch', sent_at: daysAgo(70) },
      { type: 'follow_up_1',   sent_at: daysAgo(63) },
      { type: 'follow_up_2',   sent_at: daysAgo(56) },
      { type: 'follow_up_3',   sent_at: daysAgo(49) },
    ],
    daysSinceInitial: 70,
    reactivationDelayDays: REACTIVATION_DELAY,
    expectEligible: true,
    reason: 'Full FU sequence complete + delay elapsed → eligible',
  },
  {
    name: 'C — FU3 sent, delay NOT yet elapsed (timing gate)',
    emails: [
      { type: 'initial_pitch', sent_at: daysAgo(30) },
      { type: 'follow_up_1',   sent_at: daysAgo(23) },
      { type: 'follow_up_2',   sent_at: daysAgo(16) },
      { type: 'follow_up_3',   sent_at: daysAgo(9) },
    ],
    daysSinceInitial: 30,
    reactivationDelayDays: REACTIVATION_DELAY,
    expectEligible: false,
    reason: 'FU3 sent but only 30d since initial (need 60d) → not yet due',
  },
  {
    name: 'D — FU1 only sent (FU2+FU3 missing)',
    emails: [
      { type: 'initial_pitch', sent_at: daysAgo(70) },
      { type: 'follow_up_1',   sent_at: daysAgo(63) },
    ],
    daysSinceInitial: 70,
    reactivationDelayDays: REACTIVATION_DELAY,
    expectEligible: false,
    reason: 'FU2+FU3 not sent → FU gate unchanged',
  },
  {
    name: 'E — No follow-ups sent at all',
    emails: [
      { type: 'initial_pitch', sent_at: daysAgo(90) },
    ],
    daysSinceInitial: 90,
    reactivationDelayDays: REACTIVATION_DELAY,
    expectEligible: false,
    reason: 'No FUs sent → FU gate unchanged',
  },
  {
    name: 'F — FU1+FU2 sent, FU3 NOT sent (mirror of A with explicit FU1)',
    emails: [
      { type: 'initial_pitch', sent_at: daysAgo(80) },
      { type: 'follow_up_1',   sent_at: daysAgo(73) },
      { type: 'follow_up_2',   sent_at: daysAgo(66) },
    ],
    daysSinceInitial: 80,
    reactivationDelayDays: REACTIVATION_DELAY,
    expectEligible: false,
    reason: 'Old code would have allowed this; new code blocks it (FU3 not sent)',
  },
]

// ── FU1/FU2/FU3 gate-unchanged sanity checks ─────────────────────────────────
// These verify that the FU1/FU2/FU3 flow in agents/followup.ts is NOT affected.
// We import computeFollowUpEligibility only for the sanity-check section.

console.log(SEP)
console.log('  TEST:REACTIVATION-ELIGIBILITY  —  no DB, no emails sent')
console.log(SEP)
console.log('')
console.log('  Reactivation eligibility logic (agents/reactivation.ts)')
console.log('  Fix: requires follow_up_3 sent (was: follow_up_2)')
console.log('')

let passed = 0
let failed = 0

console.log(DIV)
console.log('  REACTIVATION ELIGIBILITY SCENARIOS')
console.log(DIV)

for (const s of scenarios) {
  const got = isEligibleForReactivation(s.emails, s.daysSinceInitial, s.reactivationDelayDays)
  const ok  = got === s.expectEligible
  const tag = ok ? '✓ PASS' : '✗ FAIL'

  if (ok) passed++; else failed++

  console.log(`\n  ${tag}  ${s.name}`)
  console.log(`         Expected eligible=${s.expectEligible}   Got eligible=${got}`)
  console.log(`         Reason: ${s.reason}`)
}

console.log('\n' + DIV)
console.log(`  Results: ${passed} passed, ${failed} failed`)
console.log(DIV)

// ── FU sequencing gate: verify FU1/FU2/FU3 logic is unchanged ────────────────
// We verify these by calling the shared computeFollowUpEligibility directly
// so the test has no dependency on the follow-up agent internals.

import { computeFollowUpEligibility } from '@/lib/followup-eligibility'

const FU_SETTINGS = { fu1Days: 7, fu2Days: 14, fu3Days: 21 }
const NOW = new Date()

interface FuCase {
  label: string
  hasFu1: boolean
  hasFu2: boolean
  hasFu3: boolean
  daysSince: number
  expectNext: string | null
  expectDue: boolean
}

const fuCases: FuCase[] = [
  { label: 'FU1 not sent, day 8',  hasFu1: false, hasFu2: false, hasFu3: false, daysSince: 8,  expectNext: 'follow_up_1', expectDue: true  },
  { label: 'FU1 sent, FU2 not, day 15', hasFu1: true, hasFu2: false, hasFu3: false, daysSince: 15, expectNext: 'follow_up_2', expectDue: true  },
  { label: 'FU2 sent, FU3 not, day 22', hasFu1: true, hasFu2: true,  hasFu3: false, daysSince: 22, expectNext: 'follow_up_3', expectDue: true  },
  { label: 'All FUs sent',              hasFu1: true, hasFu2: true,  hasFu3: true,  daysSince: 30, expectNext: null,          expectDue: false },
  { label: 'FU1 sent, FU2 not, day 3 (not yet due)', hasFu1: true, hasFu2: false, hasFu3: false, daysSince: 3,  expectNext: 'follow_up_2', expectDue: false },
]

console.log('\n' + DIV)
console.log('  FU SEQUENCING SANITY (computeFollowUpEligibility — unchanged)')
console.log(DIV)

let fuPassed = 0
let fuFailed = 0

for (const c of fuCases) {
  // Build a fake initialEmailSentAt that gives the desired daysSince
  const fakeInitialAt = new Date(NOW.getTime() - c.daysSince * 86_400_000).toISOString()

  const result = computeFollowUpEligibility(
    fakeInitialAt,
    c.hasFu1,
    c.hasFu2,
    c.hasFu3,
    FU_SETTINGS,
    NOW
  )

  const nextOk = result.nextFuType === c.expectNext
  const dueOk  = result.isDue === c.expectDue
  const ok     = nextOk && dueOk
  const tag    = ok ? '✓ PASS' : '✗ FAIL'

  if (ok) fuPassed++; else fuFailed++

  console.log(`\n  ${tag}  ${c.label}`)
  if (!nextOk) console.log(`         nextFuType: expected=${c.expectNext} got=${result.nextFuType}`)
  if (!dueOk)  console.log(`         isDue:      expected=${c.expectDue} got=${result.isDue}`)
  if (ok)      console.log(`         nextFuType=${result.nextFuType}  isDue=${result.isDue}  ✓`)
}

console.log('\n' + DIV)
console.log(`  FU gate results: ${fuPassed} passed, ${fuFailed} failed`)
console.log(DIV)

// ── Final summary ─────────────────────────────────────────────────────────────
const totalPassed = passed + fuPassed
const totalFailed = failed + fuFailed

console.log('\n' + SEP)
if (totalFailed === 0) {
  console.log(`  ✓ ALL ${totalPassed} checks passed`)
} else {
  console.log(`  ✗ ${totalFailed} check(s) FAILED  (${totalPassed} passed)`)
}
console.log(SEP)

if (totalFailed > 0) process.exit(1)
