import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  assertCanaryAllowlistLeadId,
  assertCanaryEnvironment,
  assertCanaryPhase,
  assertCanaryProviderBoundary,
  assertCanarySingleRun,
  isV2CanaryEnabled,
  parseCanaryLeadIds,
  readCanaryConfiguration,
} from '@/lib/v2-canary-safety'
import {
  assertCanaryOperatorApproval,
  hashCanaryContent,
  recipientFingerprint,
  redactEmailPreview,
} from '@/lib/v2-canary-approval'
import { claimOutboundEmailIntent } from '@/lib/outbound-send'

const LEAD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LEAD_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NEXT_PUBLIC_REACHAGENT_RUNTIME: 'v2',
    REACHAGENT_ENV: 'local_v2',
    ORCHESTRATOR_ENABLED: 'false',
    ORCHESTRATOR_SHADOW: 'false',
    OUTREACH_SEND_ENABLED: 'false',
    TRIGGER_JOBS_ENABLED: 'false',
    FINDER_SCHEDULE_ENABLED: 'false',
    HOSTINGER_MUTATIONS_ENABLED: 'false',
    SHADOW_OBSERVABILITY_WRITE_ENABLED: 'false',
    V2_SHADOW_ALLOW_PRODUCTION_READS: 'false',
    V2_CANARY_ENABLED: 'false',
    ...overrides,
  }
}

function canaryEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return env({
    REACHAGENT_ENV: 'v2_canary',
    V2_CANARY_ENABLED: 'true',
    V2_CANARY_LEAD_IDS: LEAD_A,
    ORCHESTRATOR_ENABLED: 'true',
    OUTREACH_SEND_ENABLED: 'true',
    ...overrides,
  })
}

function expectThrow(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error: Error) => pattern.test(error.message))
}

async function main(): Promise<void> {
  // --- allowlist parsing ---
  assert.deepEqual(parseCanaryLeadIds(undefined), [])
  assert.deepEqual(parseCanaryLeadIds(''), [])
  assert.deepEqual(parseCanaryLeadIds('  '), [])
  expectThrow(() => parseCanaryLeadIds(','), /empty/)
  expectThrow(() => parseCanaryLeadIds('not-a-uuid'), /malformed/)
  expectThrow(() => parseCanaryLeadIds(`${LEAD_A},${LEAD_A}`), /duplicate/)
  assert.deepEqual(parseCanaryLeadIds(`  ${LEAD_A}  `), [LEAD_A])
  assert.deepEqual(parseCanaryLeadIds(`${LEAD_A},${LEAD_B}`), [LEAD_A, LEAD_B])

  // --- canary environment ---
  expectThrow(() => assertCanaryEnvironment(env({ REACHAGENT_ENV: 'v2_canary', V2_CANARY_ENABLED: 'false' })), /requires V2_CANARY_ENABLED=true/)
  expectThrow(() => assertCanaryEnvironment(canaryEnv({ ORCHESTRATOR_ENABLED: 'false' })), /requires ORCHESTRATOR_ENABLED=true/)
  expectThrow(() => assertCanaryEnvironment(canaryEnv({ ORCHESTRATOR_SHADOW: 'true' })), /forbids ORCHESTRATOR_SHADOW=true/)
  expectThrow(() => assertCanaryEnvironment(canaryEnv({ OUTREACH_SEND_ENABLED: 'false' })), /requires OUTREACH_SEND_ENABLED=true/)
  expectThrow(() => assertCanaryEnvironment(canaryEnv({ TRIGGER_JOBS_ENABLED: 'true' })), /forbids TRIGGER_JOBS_ENABLED=true/)
  expectThrow(() => assertCanaryEnvironment(canaryEnv({ FINDER_SCHEDULE_ENABLED: 'true' })), /forbids FINDER_SCHEDULE_ENABLED=true/)
  expectThrow(() => assertCanaryEnvironment(canaryEnv({ HOSTINGER_MUTATIONS_ENABLED: 'true' })), /forbids HOSTINGER_MUTATIONS_ENABLED=true/)
  assert.doesNotThrow(() => assertCanaryEnvironment(canaryEnv()))

  // --- one-ID allowlist ---
  assert.doesNotThrow(() => assertCanaryAllowlistLeadId(LEAD_A, canaryEnv()))
  expectThrow(() => assertCanaryAllowlistLeadId(LEAD_B, canaryEnv()), /not allowlisted/)
  expectThrow(() => assertCanaryAllowlistLeadId(LEAD_A, canaryEnv({ V2_CANARY_LEAD_IDS: `${LEAD_A},${LEAD_B}` })), /exactly one/)
  assert.doesNotThrow(() => assertCanarySingleRun(canaryEnv()))

  // --- phase ---
  assert.doesNotThrow(() => assertCanaryPhase('initial_pitch'))
  for (const phase of ['follow_up_1', 'follow_up_2', 'follow_up_3', 'reactivation', undefined, null]) {
    expectThrow(() => assertCanaryPhase(phase as string | null | undefined), /allows only initial_pitch/)
  }

  // --- provider boundary ---
  assert.doesNotThrow(() => assertCanaryProviderBoundary({ leadId: LEAD_A, phase: 'initial_pitch' }, canaryEnv()))
  expectThrow(() => assertCanaryProviderBoundary({ leadId: LEAD_B, phase: 'initial_pitch' }, canaryEnv()), /not allowlisted/)
  expectThrow(() => assertCanaryProviderBoundary({ leadId: LEAD_A, phase: 'follow_up_1' }, canaryEnv()), /allows only initial_pitch/)
  assert.doesNotThrow(() => assertCanaryProviderBoundary({ leadId: LEAD_B, phase: 'follow_up_1' }, env()))

  // --- content hash / approval ---
  const base = { recipient: 'a@example.com', sender: 'S <s@example.com>', subject: 'hi', html: '<b>hi</b>', text: 'hi', intentId: 'i1', phase: 'initial_pitch' }
  const h1 = hashCanaryContent(base)
  const h2 = hashCanaryContent(base)
  assert.equal(h1, h2)
  assert.notEqual(h1, hashCanaryContent({ ...base, recipient: 'b@example.com' }))
  assert.match(h1, /^[a-f0-9]{64}$/)
  assert.equal(redactEmailPreview('alice@example.com'), 'al***@example.com')
  assert.equal(redactEmailPreview(null), '<missing>')

  const binding = { leadId: LEAD_A, recipientFingerprint: recipientFingerprint('a@example.com'), contentHash: h1, intentId: 'i1', sender: 'S <s@example.com>' }
  expectThrow(() => assertCanaryOperatorApproval(binding, {}), /V2_CANARY_APPROVAL_TOKEN/)
  expectThrow(() => assertCanaryOperatorApproval(binding, { V2_CANARY_APPROVAL_TOKEN: 't' }), /V2_CANARY_APPROVED_CONTENT_HASH/)
  expectThrow(() => assertCanaryOperatorApproval(binding, { V2_CANARY_APPROVAL_TOKEN: 't', V2_CANARY_APPROVED_CONTENT_HASH: 'deadbeef' }), /V2_CANARY_APPROVAL_REFERENCE/)
  expectThrow(() => assertCanaryOperatorApproval(binding, { V2_CANARY_APPROVAL_TOKEN: 't', V2_CANARY_APPROVED_CONTENT_HASH: 'deadbeef', V2_CANARY_APPROVAL_REFERENCE: 'r' }), /differs/)
  assert.deepEqual(
    assertCanaryOperatorApproval(binding, { V2_CANARY_APPROVAL_TOKEN: 't', V2_CANARY_APPROVED_CONTENT_HASH: h1, V2_CANARY_APPROVAL_REFERENCE: 'r' }),
    { reference: 'r' },
  )

  // --- atomic claim (mock conditional update) ---
  const row = { id: 'e1', status: 'sending', resend_id: null, message_id: '<e1@aussieventure.com>', subject: 's', body_html: 'h', body_text: 't', claimed_at: 'now', send_envelope: {} }
  function fakeClient(result: unknown, error: unknown = null): SupabaseClient {
    const update = { status: '', claimed_at: '', message_id: '', send_envelope: {} }
    return {
      from: () => ({
        update: (payload: Record<string, unknown>) => { Object.assign(update, payload); return builder() },
      }),
    } as unknown as SupabaseClient
    function builder(): any {
      return {
        eq: () => builder(),
        select: () => ({ maybeSingle: async () => ({ data: result, error }) }),
      }
    }
  }

  const claimed = await claimOutboundEmailIntent(fakeClient(row), {
    leadId: LEAD_A, emailId: 'e1', messageId: '<e1@aussieventure.com>',
    envelope: { content_hash: 'h', sender_identity: 's', recipient_fingerprint: 'f', idempotency_key: 'k', correlation_id: 'c', approval_reference: 'r' },
  })
  assert.equal(claimed.claimed, true)
  assert.equal(claimed.intent?.status, 'sending')

  const lost = await claimOutboundEmailIntent(fakeClient(null), {
    leadId: LEAD_A, emailId: 'e1', messageId: '<e1@aussieventure.com>',
    envelope: { content_hash: 'h', sender_identity: 's', recipient_fingerprint: 'f', idempotency_key: 'k', correlation_id: 'c', approval_reference: 'r' },
  })
  assert.equal(lost.claimed, false)
  assert.equal(lost.intent, null)

  // --- config read / gate flags ---
  assert.equal(isV2CanaryEnabled(env()), false)
  assert.equal(isV2CanaryEnabled(canaryEnv()), true)
  assert.deepEqual(readCanaryConfiguration(canaryEnv()), { enabled: true, reachAgentEnv: 'v2_canary', leadIds: [LEAD_A] })

  console.log('REACHAGENT_V2_CANARY_SAFETY_TEST_PASS')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
