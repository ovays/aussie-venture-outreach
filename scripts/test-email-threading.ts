/**
 * scripts/test-email-threading.ts
 *
 * Verifies the RFC 5322 threading fix:
 *   - buildThreadingHeaders (src/lib/resend.ts) generates a unique Message-ID
 *     per send, and In-Reply-To/References when a prior thread is passed
 *   - buildReferenceChain (agents/followup.ts) builds the correct oldest-first
 *     chain from a lead's prior sent emails, skipping unsent/pre-migration
 *     (message_id-less) rows
 *   - "Re:" subjects are unchanged for both the AI path (writeFollowUpEmail)
 *     and its static-template fallback (buildFollowUpEmail) — this fix only
 *     adds headers, it does not touch subject/AI prompt behaviour
 *
 * Pure / in-memory — no network, no DB.
 *
 * Run: npx tsx scripts/test-email-threading.ts
 */

import { buildThreadingHeaders } from '@/lib/resend'
import { buildReferenceChain } from '../agents/followup'
import { buildFollowUpEmail } from '@/lib/followup-email-templates'
import { generateFollowUpEmail } from '@/lib/followup-generation'

const SEP = '═'.repeat(60)
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

console.log(SEP)
console.log('  TEST:EMAIL-THREADING')
console.log(SEP)

// ── 1. New thread (no references) gets a Message-ID and nothing else ───────
console.log('\n  1. buildThreadingHeaders — new thread (initial pitch)')
{
  const { messageId, headers } = buildThreadingHeaders()
  assert(/^<[0-9a-f-]{36}@aussieventure\.com>$/.test(messageId), 'messageId is a well-formed RFC 5322 Message-ID', messageId)
  assert(headers['Message-ID'] === messageId, 'headers["Message-ID"] matches the returned messageId')
  assert(headers['In-Reply-To'] === undefined, 'No In-Reply-To header for a new thread')
  assert(headers['References'] === undefined, 'No References header for a new thread')
}

// ── 2. Follow-up (with references) threads correctly ───────────────────────
console.log('\n  2. buildThreadingHeaders — follow-up in an existing thread')
{
  const initial = '<initial-uuid@aussieventure.com>'
  const fu1 = '<fu1-uuid@aussieventure.com>'
  const { headers } = buildThreadingHeaders([initial, fu1])
  assert(headers['In-Reply-To'] === fu1, 'In-Reply-To is the most recent (last) message in the chain', headers['In-Reply-To'])
  assert(headers['References'] === `${initial} ${fu1}`, 'References lists the full chain, oldest first', headers['References'])
}

// ── 3. Message-IDs are unique per send ──────────────────────────────────────
console.log('\n  3. buildThreadingHeaders — uniqueness')
{
  const a = buildThreadingHeaders().messageId
  const b = buildThreadingHeaders().messageId
  assert(a !== b, 'Two calls produce two different Message-IDs', `${a} vs ${b}`)
}

// ── 4. buildReferenceChain — ordering and filtering ─────────────────────────
console.log('\n  4. buildReferenceChain — ordering and filtering')
{
  const emails = [
    { id: '3', type: 'follow_up_1', subject: 'Re: x', body_text: '', sent_at: '2026-02-01T00:00:00Z', status: 'sent', message_id: '<fu1@x>' },
    { id: '1', type: 'initial_pitch', subject: 'x', body_text: '', sent_at: '2026-01-01T00:00:00Z', status: 'sent', message_id: '<initial@x>' },
    { id: '2', type: 'follow_up_1', subject: 'Re: x', body_text: '', sent_at: null, status: 'pending_send', message_id: null }, // not sent yet — excluded
    { id: '4', type: 'initial_pitch', subject: 'old', body_text: '', sent_at: '2025-01-01T00:00:00Z', status: 'sent', message_id: null }, // sent before message_id existed — excluded, no header to reference
  ]
  const chain = buildReferenceChain(emails)
  assert(chain.length === 2, 'Only sent rows with a message_id are included', JSON.stringify(chain))
  assert(chain[0] === '<initial@x>' && chain[1] === '<fu1@x>', 'Chain is ordered oldest-first', JSON.stringify(chain))
}

// ── 5. buildReferenceChain — no prior message_ids degrades gracefully ──────
console.log('\n  5. buildReferenceChain — pre-migration leads (no message_id at all)')
{
  const emails = [
    { id: '1', type: 'initial_pitch', subject: 'x', body_text: '', sent_at: '2026-01-01T00:00:00Z', status: 'sent', message_id: null },
  ]
  const chain = buildReferenceChain(emails)
  assert(chain.length === 0, 'A lead whose initial pitch predates this migration produces an empty chain (no crash, no fake reference)', JSON.stringify(chain))
}

// ── 6. "Re:" subject is unchanged — static template fallback ───────────────
console.log('\n  6. "Re:" subject preserved — static template fallback')
{
  const result = buildFollowUpEmail('follow_up_1', 'Test Biz', 'Collab with Aussie Venture?', 'Nail Salons', 'remote')
  assert(result.subject === 'Re: Collab with Aussie Venture?', '"Re:" prefix + exact original subject is preserved', result.subject)
}

// ── 7. "Re:" subject is unchanged — generateFollowUpEmail (AI path, stubbed) ──
async function testGenerateFollowUpSubject() {
  console.log('\n  7. "Re:" subject preserved — generateFollowUpEmail with AI stub')

  const context = {
    businessName: 'Test Biz', category: 'Nail Salons', suburb: 'Bondi', city: 'Sydney',
    website: '', description: '', services: '', notes: '', contentType: 'remote',
  }

  // AI generator stub that returns a body but relies on the caller for subject —
  // matches writeFollowUpEmail's real contract (subject is always `Re: ${initial_subject}`,
  // computed before the API call, not returned by the model).
  const aiStub = async (params: { initial_subject: string }) => ({
    subject: `Re: ${params.initial_subject}`,
    body: 'AI generated body',
  })

  const result = await generateFollowUpEmail('follow_up_1', context, 'Original Subject', [], aiStub as never)
  assert(result.subject === 'Re: Original Subject', 'AI-path subject keeps the exact "Re: " + original subject format', result.subject)
  assert(result.source === 'ai', 'Source is "ai" when the generator succeeds')

  // Failure path — falls back to the static template, subject rule still holds.
  const failingStub = async (): Promise<{ subject: string; body: string }> => {
    throw new Error('simulated Claude failure')
  }
  const fallback = await generateFollowUpEmail('follow_up_1', context, 'Original Subject', [], failingStub as never)
  assert(fallback.subject === 'Re: Original Subject', 'Fallback-path subject also keeps "Re: " + original subject', fallback.subject)
  assert(fallback.source === 'template', 'Source is "template" when the AI generator throws')
}

testGenerateFollowUpSubject().then(() => {
  console.log('\n' + SEP)
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`)
  console.log(SEP)

  if (failed > 0) {
    console.error('\n  ✗ Some tests failed — review output above.')
    process.exit(1)
  } else {
    console.log('\n  ✓ All tests passed.')
  }
})
