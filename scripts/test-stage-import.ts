/**
 * scripts/test-stage-import.ts
 *
 * Pure-logic test for src/lib/stage-import.ts — no DB, no network calls.
 * Verifies that backdated sent_at timestamps produced for a staged lead
 * import make the unmodified follow-up eligibility engine
 * (src/lib/followup-eligibility.ts) schedule the next stage exactly
 * `interval` days after the user-supplied Stage Completed Date.
 *
 * Run: npm run test:stage-import
 */

import { computeBackdatedStageEmails, STAGE_VALUES, STAGE_LABELS, type LeadImportStage } from '@/lib/stage-import'
import { computeFollowUpEligibility, isFuEmailSent } from '@/lib/followup-eligibility'

const SETTINGS = { fu1Days: 7, fu2Days: 14, fu3Days: 21 }
const DAY = 86_400_000

let failures = 0

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`)
  } else {
    console.log(`  ✗ ${message}`)
    failures++
  }
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / DAY)
}

console.log('═'.repeat(62))
console.log('  TEST:STAGE-IMPORT — pure logic, no DB')
console.log('═'.repeat(62))

// 1. 'new' produces no backfilled emails
console.log('\n[1] "new" stage produces no emails')
assert(computeBackdatedStageEmails('new', new Date(), SETTINGS).length === 0, 'new → []')

// 2. Every non-'new' stage has an option + label
console.log('\n[2] All stage values have labels')
for (const stage of STAGE_VALUES) {
  assert(typeof STAGE_LABELS[stage] === 'string' && STAGE_LABELS[stage].length > 0, `${stage} → "${STAGE_LABELS[stage]}"`)
}

// 3. Worked example from the spec: Initial Email Sent, completed today.
//    Result: initial_pitch.sent_at = today; FU1 due exactly fu1Days later.
console.log('\n[3] Spec example — Initial Email Sent completed today')
{
  const completedDate = new Date()
  const emails = computeBackdatedStageEmails('initial_sent', completedDate, SETTINGS)
  assert(emails.length === 1, 'exactly 1 email row (initial_pitch)')
  assert(emails[0].type === 'initial_pitch', 'row type is initial_pitch')
  assert(daysBetween(emails[0].sentAt, completedDate) === 0, 'initial_pitch.sent_at === completedDate')

  const eligibility = computeFollowUpEligibility(
    emails[0].sentAt.toISOString(), false, false, false, SETTINGS, completedDate
  )
  assert(eligibility.nextFuType === 'follow_up_1', 'next due stage is follow_up_1')
  assert(eligibility.isDue === false, 'FU1 not immediately due')
  assert(eligibility.daysUntilDue === SETTINGS.fu1Days, `FU1 due in exactly ${SETTINGS.fu1Days} days`)
}

// 4. Follow-up 1 Sent, completed today — FU2 must be due exactly
//    (fu2Days - fu1Days) days from today, per the existing interval,
//    NOT 14 days from today.
console.log('\n[4] Follow-up 1 Sent completed today → FU2 uses the existing gap')
{
  const completedDate = new Date()
  const emails = computeBackdatedStageEmails('follow_up_1', completedDate, SETTINGS)
  assert(emails.length === 2, 'exactly 2 email rows (initial_pitch + follow_up_1)')

  const initial = emails.find((e) => e.type === 'initial_pitch')!
  const fu1 = emails.find((e) => e.type === 'follow_up_1')!
  assert(daysBetween(fu1.sentAt, completedDate) === 0, 'follow_up_1.sent_at === completedDate')
  assert(daysBetween(completedDate, initial.sentAt) === SETTINGS.fu1Days, `initial_pitch backdated by fu1Days (${SETTINGS.fu1Days}d)`)

  const eligibility = computeFollowUpEligibility(
    initial.sentAt.toISOString(), true, false, false, SETTINGS, completedDate
  )
  assert(eligibility.nextFuType === 'follow_up_2', 'next due stage is follow_up_2')
  assert(
    eligibility.daysUntilDue === SETTINGS.fu2Days - SETTINGS.fu1Days,
    `FU2 due in exactly ${SETTINGS.fu2Days - SETTINGS.fu1Days} days (existing interval from completed date)`
  )
}

// 5. Follow-up 3 Sent (final stage) — all follow-ups accounted for, engine
//    reports nothing left to send (matches "continue existing sequence,
//    never resend a completed stage").
console.log('\n[5] Follow-up 3 Sent completed today → all follow-ups exhausted')
{
  const completedDate = new Date()
  const emails = computeBackdatedStageEmails('follow_up_3', completedDate, SETTINGS)
  assert(emails.length === 4, 'exactly 4 email rows (initial + FU1 + FU2 + FU3)')
  assert(new Set(emails.map((e) => e.type)).size === 4, 'no duplicate stage types')

  const initial = emails.find((e) => e.type === 'initial_pitch')!
  const eligibility = computeFollowUpEligibility(
    initial.sentAt.toISOString(), true, true, true, SETTINGS, completedDate
  )
  assert(eligibility.nextFuType === null, 'no further follow-up scheduled')
}

// 6. Never resend a completed stage — every backfilled row is "sent"
//    according to isFuEmailSent, for every reachable stage.
console.log('\n[6] Every backfilled stage counts as already-sent')
{
  const completedDate = new Date()
  for (const stage of STAGE_VALUES.filter((s): s is Exclude<LeadImportStage, 'new'> => s !== 'new')) {
    const emails = computeBackdatedStageEmails(stage, completedDate, SETTINGS)
    const allSent = emails.every((e) => isFuEmailSent({ sent_at: e.sentAt.toISOString() }))
    assert(allSent, `${stage}: all ${emails.length} backfilled rows are sent`)
  }
}

// 7. Sent_at ordering is monotonic and matches configured day gaps exactly,
//    for a custom (non-default) settings configuration too.
console.log('\n[7] Custom intervals (fu1=3, fu2=10, fu3=20) still produce correct gaps')
{
  const custom = { fu1Days: 3, fu2Days: 10, fu3Days: 20 }
  const completedDate = new Date()
  const emails = computeBackdatedStageEmails('follow_up_2', completedDate, custom)
  const initial = emails.find((e) => e.type === 'initial_pitch')!
  const fu1 = emails.find((e) => e.type === 'follow_up_1')!
  const fu2 = emails.find((e) => e.type === 'follow_up_2')!

  assert(daysBetween(fu1.sentAt, initial.sentAt) === custom.fu1Days, 'FU1 gap from initial matches fu1Days')
  assert(daysBetween(fu2.sentAt, initial.sentAt) === custom.fu2Days, 'FU2 gap from initial matches fu2Days')
  assert(daysBetween(fu2.sentAt, completedDate) === 0, 'FU2 (target stage) lands exactly on completedDate')
}

console.log('\n' + '═'.repeat(62))
if (failures === 0) {
  console.log('  ✓ ALL CHECKS PASSED')
  console.log('═'.repeat(62))
  process.exit(0)
} else {
  console.log(`  ✗ ${failures} CHECK(S) FAILED`)
  console.log('═'.repeat(62))
  process.exit(1)
}
