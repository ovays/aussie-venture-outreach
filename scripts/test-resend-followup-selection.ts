/**
 * scripts/test-resend-followup-selection.ts
 *
 * Regression test for a QA bug: manually setting a lead to "Initial Email
 * Sent" (via the staged-import stage picker, which backdates an
 * initial_pitch row — see src/lib/stage-import.ts) correctly made the lead
 * eligible for "Follow-up 1 Due" on the lifecycle dashboard, but clicking
 * "Send Email" on that lead sent ANOTHER initial outreach pitch instead of
 * follow-up 1.
 *
 * Root cause: src/app/api/leads/[id]/resend/route.ts always looked for a
 * `type='initial_pitch', status='pending_send'` draft and, failing to find
 * one (there won't be one for an already-contacted lead), fell through to
 * generating and sending a brand-new initial pitch via writeOutreachEmail —
 * regardless of how many emails had already been sent to that lead. The
 * eligibility engine (src/lib/followup-eligibility.ts, used by
 * /api/lifecycle and the automated cron in agents/followup.ts) was never
 * consulted by the manual send path at all.
 *
 * The fix extracts a shared, pure decision function —
 * determineNextEmailType() in src/lib/email-sequence.ts — that inspects the
 * lead's actual emails history to decide whether the next send is the
 * initial pitch, follow-up 1/2/3, or nothing (sequence complete). Both the
 * manual resend route and the automated cron now derive "what's next" from
 * the same source of truth.
 *
 * Part 1 is a pure-logic test of determineNextEmailType() (no DB, no
 * network). Part 2 is a static-source check of the resend route itself,
 * consistent with this repo's convention for routes with no DB injection
 * seam (see scripts/test-resend-send-idempotency.ts) — it verifies the
 * route actually calls the decision function and branches to the follow-up
 * writer, rather than unconditionally hardcoding 'initial_pitch'.
 *
 * Run: npx tsx scripts/test-resend-followup-selection.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { determineNextEmailType, buildEmailHistory, buildReferenceChain, type LeadEmailForThread } from '@/lib/email-sequence'

const SEP = '═'.repeat(62)
let passed = 0
let failed = 0

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

function email(overrides: Partial<LeadEmailForThread>): LeadEmailForThread {
  return {
    type: 'initial_pitch',
    subject: 'Collab with Aussie Venture - Sea Cliff House',
    body_text: 'Hey Sea Cliff House...',
    sent_at: null,
    status: 'pending_send',
    message_id: null,
    ...overrides,
  }
}

console.log(SEP)
console.log('  TEST:RESEND-FOLLOWUP-SELECTION')
console.log(SEP)

console.log('\n  1. determineNextEmailType — pure decision logic')
{
  assert(
    determineNextEmailType([]).kind === 'initial',
    'No emails at all → next send is the initial pitch'
  )

  assert(
    determineNextEmailType([email({ status: 'pending_send', sent_at: null })]).kind === 'initial',
    'An initial_pitch draft that has NOT been sent yet (pending_send, sent_at null) → still the initial pitch'
  )

  // The exact QA scenario: a lead whose initial pitch was already delivered
  // (e.g. via a backdated staged import setting "Initial Email Sent") must
  // be routed to follow_up_1, never another initial pitch.
  const afterInitialSent = determineNextEmailType([
    email({ type: 'initial_pitch', status: 'sent', sent_at: '2026-07-01T00:00:00Z' }),
  ])
  assert(afterInitialSent.kind === 'follow_up', 'Initial pitch already sent → next send is a follow-up, not another initial pitch')
  if (afterInitialSent.kind === 'follow_up') {
    assert(afterInitialSent.type === 'follow_up_1', 'Initial pitch sent, no follow-ups yet → next is follow_up_1')
    assert(afterInitialSent.initialEmail.sent_at === '2026-07-01T00:00:00Z', 'The sent initial_pitch row is surfaced for subject/history use')
  }

  const afterFu1Sent = determineNextEmailType([
    email({ type: 'initial_pitch', status: 'sent', sent_at: '2026-07-01T00:00:00Z' }),
    email({ type: 'follow_up_1', status: 'sent', sent_at: '2026-07-08T00:00:00Z' }),
  ])
  assert(afterFu1Sent.kind === 'follow_up' && afterFu1Sent.type === 'follow_up_2', 'Initial + FU1 sent → next is follow_up_2')

  const afterFu2Sent = determineNextEmailType([
    email({ type: 'initial_pitch', status: 'sent', sent_at: '2026-07-01T00:00:00Z' }),
    email({ type: 'follow_up_1', status: 'sent', sent_at: '2026-07-08T00:00:00Z' }),
    email({ type: 'follow_up_2', status: 'sent', sent_at: '2026-07-15T00:00:00Z' }),
  ])
  assert(afterFu2Sent.kind === 'follow_up' && afterFu2Sent.type === 'follow_up_3', 'Initial + FU1 + FU2 sent → next is follow_up_3')

  const allSent = determineNextEmailType([
    email({ type: 'initial_pitch', status: 'sent', sent_at: '2026-07-01T00:00:00Z' }),
    email({ type: 'follow_up_1', status: 'sent', sent_at: '2026-07-08T00:00:00Z' }),
    email({ type: 'follow_up_2', status: 'sent', sent_at: '2026-07-15T00:00:00Z' }),
    email({ type: 'follow_up_3', status: 'sent', sent_at: '2026-07-22T00:00:00Z' }),
  ])
  assert(allSent.kind === 'all_sent', 'All 4 stages sent → nothing left to send')

  // "Sent" is judged by sent_at presence, not status — a bounced initial
  // pitch still counts as delivered (matches isFuEmailSent's contract), so
  // a bounce must not cause the route to send ANOTHER initial pitch either.
  const bounced = determineNextEmailType([
    email({ type: 'initial_pitch', status: 'bounced', sent_at: '2026-07-01T00:00:00Z' }),
  ])
  assert(bounced.kind === 'follow_up' && bounced.type === 'follow_up_1', 'A bounced (but sent_at-stamped) initial pitch still advances the sequence to follow_up_1')
}

console.log('\n  2. Static source check — resend/route.ts consults the decision function')
{
  const routeSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/app/api/leads/[id]/resend/route.ts'),
    'utf8'
  )

  assert(
    /from ['"]@\/lib\/email-sequence['"]/.test(routeSrc) && /determineNextEmailType\(/.test(routeSrc),
    'route.ts imports and calls determineNextEmailType()'
  )
  assert(
    /from ['"]@\/lib\/followup-generation['"]/.test(routeSrc) && /generateFollowUpEmail\(/.test(routeSrc),
    'route.ts imports and calls generateFollowUpEmail() for the follow-up branch'
  )
  assert(
    /decision\.kind === ['"]all_sent['"]/.test(routeSrc),
    "route.ts explicitly handles the 'all_sent' case (does not silently fall through to sending an initial pitch)"
  )

  const emailsQueryIdx = routeSrc.indexOf(".from('emails')\n    .select('id, type, subject, body_text, body_html, sent_at, status, message_id')")
  const decisionIdx = routeSrc.indexOf('determineNextEmailType(emails)')
  const pendingDraftIdx = routeSrc.indexOf("eq('status', 'pending_send')")
  assert(emailsQueryIdx !== -1, "route.ts queries the lead's full emails history before deciding what to send")
  assert(decisionIdx !== -1 && emailsQueryIdx < decisionIdx, 'The decision is computed from that history query, not assumed')
  assert(decisionIdx < pendingDraftIdx, 'The decision is made BEFORE looking for a pending_send draft (which only exists for a true initial send)')

  // The insert()/final email row must use the decided type, not a hardcoded
  // 'initial_pitch' literal — this was the exact bug (three call sites
  // hardcoded 'initial_pitch' regardless of what was actually generated).
  const insertBlockMatches = routeSrc.match(/\.from\('emails'\)\.insert\(\{[^}]*\}\)/g) ?? []
  assert(insertBlockMatches.length >= 2, 'route.ts still has its emails-insert call sites (sent row + sync-failed recovery row)', `found ${insertBlockMatches.length}`)
  for (const block of insertBlockMatches) {
    assert(!/type:\s*'initial_pitch'/.test(block), 'An emails insert block does not hardcode type: \'initial_pitch\'', block.slice(0, 80))
    assert(/type:\s*emailType/.test(block), 'An emails insert block uses the decided `emailType` variable', block.slice(0, 80))
  }
}

console.log('\n  3. buildEmailHistory / buildReferenceChain are re-exported for the resend route to reuse')
{
  const history = buildEmailHistory([
    email({ type: 'initial_pitch', status: 'sent', sent_at: '2026-07-01T00:00:00Z', body_text: 'INITIAL_MARKER' }),
    email({ type: 'follow_up_1', status: 'sent', sent_at: '2026-07-08T00:00:00Z', body_text: 'FU1_MARKER' }),
  ])
  assert(history.length === 2, 'buildEmailHistory returns both sent emails')
  assert(history[0].body === 'INITIAL_MARKER' && history[1].body === 'FU1_MARKER', 'buildEmailHistory orders oldest-first')

  const refs = buildReferenceChain([
    email({ type: 'initial_pitch', status: 'sent', sent_at: '2026-07-01T00:00:00Z', message_id: '<initial@aussieventure.com>' }),
  ])
  assert(refs.length === 1 && refs[0] === '<initial@aussieventure.com>', 'buildReferenceChain surfaces prior Message-IDs for threading')
}

console.log('\n' + SEP)
console.log(`  RESULTS: ${passed} passed, ${failed} failed`)
console.log(SEP)

if (failed > 0) {
  console.error('\n  ✗ Some tests failed — review output above.')
  process.exit(1)
} else {
  console.log('\n  ✓ All tests passed.')
}
