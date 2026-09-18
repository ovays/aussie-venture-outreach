import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { decideNextAction, type DecisionAction, type LeadDecisionContext, type LeadDecisionResult } from '../src/domain/decision-engine'
import {
  createExecutorRegistry, decisionStateFingerprint, orchestrateLead, orchestrateLeadBatch,
  readOrchestratorFlags, type ExecutorRegistry, type OrchestrationRequest, type OrchestratorDependencies,
} from '../src/domain/orchestrator'

type MutableContext = LeadDecisionContext

function context(overrides: Partial<MutableContext> = {}): MutableContext {
  return {
    leadId: '00000000-0000-4000-8000-000000000001', status: 'new', email: 'owner@example.test',
    duplicate: false, suppressed: false, dealState: 'none', initialEmailMode: 'ai_personalised',
    research: { contactDiscoveryComplete: false, personalisationComplete: false, canSupplyTemplateFields: true },
    template: { available: false, requiredDataAvailable: false },
    initialEmail: { state: 'missing', sentAt: null },
    followUps: {
      followUp1: { state: 'missing', sentAt: null }, followUp2: { state: 'missing', sentAt: null },
      followUp3: { state: 'missing', sentAt: null },
    },
    reply: { received: false, classification: null }, reactivation: { enabled: true, sentAt: null },
    schedule: { followUp1Days: 7, followUp2Days: 14, followUp3Days: 21, deadLeadDays: 21, reactivationDelayDays: 60, deadAfterReactivationDays: 14 },
    asOf: '2026-09-15T00:00:00.000Z', manualOverride: null, ...overrides,
  }
}

function request(leadId = context().leadId): OrchestrationRequest {
  return { workflowType: 'lead_lifecycle', leadId, source: 'synthetic.test' }
}

function harness(input: {
  contexts: MutableContext[]
  executors?: ExecutorRegistry
  decide?: (value: MutableContext) => LeadDecisionResult
  acquire?: () => Promise<string | null>
}) {
  let loadIndex = 0
  let executorCalls = 0
  const steps: Array<Record<string, unknown>> = []
  const telemetry = {
    async startWorkflowRun() { return 'run-1' },
    async completeWorkflowRun() { return true },
    async failWorkflowRun() { return true },
    async startWorkflowStep(value: Record<string, unknown>) { steps.push(value); return `step-${steps.length}` },
    async completeWorkflowStep() { return true },
    async failWorkflowStep() { return true },
  }
  const fallback = async () => { executorCalls++; return { outcome: 'completed' as const, changedState: true } }
  const deps: OrchestratorDependencies = {
    client: {} as OrchestratorDependencies['client'], telemetry,
    executors: input.executors ?? Object.fromEntries(['RESEARCH', 'GENERATE_INITIAL', 'SEND_INITIAL', 'SEND_FOLLOWUP_1', 'SEND_FOLLOWUP_2', 'SEND_FOLLOWUP_3', 'REACTIVATE', 'MARK_DEAD'].map((action) => [action, fallback])),
    loadContext: async () => input.contexts[Math.min(loadIndex++, input.contexts.length - 1)] ?? null,
    decide: input.decide ?? decideNextAction,
    acquireLeadLock: input.acquire ? async () => input.acquire!() : async () => 'lock-1',
    releaseLeadLock: async () => {},
  }
  return { deps, steps, calls: () => executorCalls }
}

async function testTemplateAndPersonalizedPaths() {
  const templateNew = context({
    initialEmailMode: 'template', research: { contactDiscoveryComplete: false, personalisationComplete: false, canSupplyTemplateFields: true },
    template: { available: true, requiredDataAvailable: true },
  })
  assert.equal(decideNextAction(templateNew).action, 'GENERATE_INITIAL', 'template-ready lead skips Research AI')
  const templateMissingData = context({ initialEmailMode: 'template', email: null, template: { available: true, requiredDataAvailable: false } })
  assert.equal(decideNextAction(templateMissingData).action, 'RESEARCH')
  const templateManual = context({ initialEmailMode: 'template', template: { available: false, requiredDataAvailable: false } })
  assert.equal(decideNextAction(templateManual).action, 'MANUAL_REVIEW')

  const ready = context({ ...templateNew, status: 'email_ready', initialEmail: { state: 'pending', sentAt: null } })
  const sentAt = '2026-09-14T00:00:00.000Z'
  const contacted = context({ ...templateNew, status: 'contacted', initialEmail: { state: 'sent', sentAt } })
  const templateHarness = harness({ contexts: [templateNew, ready, contacted] })
  const templateResult = await orchestrateLead(request(), templateHarness.deps)
  assert.deepEqual(templateResult.actionsExecuted.map((item) => item.action), ['GENERATE_INITIAL', 'SEND_INITIAL'])
  assert.equal(templateResult.stoppedBecause, 'WAIT')

  const personalisedNew = context()
  const researched = context({ status: 'researched', research: { contactDiscoveryComplete: true, personalisationComplete: true, canSupplyTemplateFields: true } })
  assert.equal(decideNextAction(personalisedNew).action, 'RESEARCH')
  assert.equal(decideNextAction(researched).action, 'GENERATE_INITIAL')
  assert.equal(decideNextAction(ready).action, 'SEND_INITIAL')
  assert.equal(decideNextAction(contacted).action, 'WAIT')
  const personalisedHarness = harness({ contexts: [personalisedNew, researched, { ...researched, status: 'email_ready', initialEmail: { state: 'pending', sentAt: null } }, contacted] })
  const personalisedResult = await orchestrateLead(request(), personalisedHarness.deps)
  assert.deepEqual(personalisedResult.actionsExecuted.map((item) => item.action), ['RESEARCH', 'GENERATE_INITIAL', 'SEND_INITIAL'])
  assert.equal(personalisedResult.stoppedBecause, 'WAIT')
}

function contactedContext(daysAgo: number, stages: Partial<MutableContext['followUps']> = {}, extra: Partial<MutableContext> = {}) {
  const sentAt = new Date(Date.parse('2026-09-15T00:00:00.000Z') - daysAgo * 86_400_000).toISOString()
  return context({
    status: 'contacted', initialEmail: { state: 'sent', sentAt },
    followUps: { followUp1: { state: 'missing', sentAt: null }, followUp2: { state: 'missing', sentAt: null }, followUp3: { state: 'missing', sentAt: null }, ...stages },
    ...extra,
  })
}

async function testFollowUpReactivationAndSafety() {
  assert.equal(decideNextAction(contactedContext(7)).action, 'SEND_FOLLOWUP_1')
  assert.equal(decideNextAction(contactedContext(14, { followUp1: { state: 'sent', sentAt: '2026-09-08T00:00:00.000Z' } })).action, 'SEND_FOLLOWUP_2')
  assert.equal(decideNextAction(contactedContext(21, { followUp1: { state: 'sent', sentAt: 'x' }, followUp2: { state: 'sent', sentAt: 'x' } })).action, 'SEND_FOLLOWUP_3')
  assert.equal(decideNextAction(contactedContext(1)).action, 'WAIT')
  const allSent = { followUp1: { state: 'sent' as const, sentAt: 'x' }, followUp2: { state: 'sent' as const, sentAt: 'x' }, followUp3: { state: 'sent' as const, sentAt: 'x' } }
  assert.equal(decideNextAction(contactedContext(30, allSent)).action, 'WAIT')
  assert.equal(decideNextAction(contactedContext(60, allSent)).action, 'REACTIVATE')
  assert.equal(decideNextAction(contactedContext(70, allSent, { reactivation: { enabled: true, sentAt: '2026-09-10T00:00:00.000Z' } })).action, 'WAIT')
  assert.equal(decideNextAction(contactedContext(80, allSent, { reactivation: { enabled: true, sentAt: '2026-08-20T00:00:00.000Z' } })).action, 'MARK_DEAD')

  for (const [label, value, action] of [
    ['suppressed', context({ suppressed: true }), 'STOP'], ['duplicate', context({ duplicate: true }), 'STOP'],
    ['missing email', context({ status: 'researched', email: null, research: { contactDiscoveryComplete: true, personalisationComplete: true, canSupplyTemplateFields: true } }), 'STOP'],
    ['uncertain', context({ status: 'email_ready', initialEmail: { state: 'uncertain', sentAt: null } }), 'MANUAL_REVIEW'],
    ['closed', context({ status: 'closed' }), 'STOP'], ['dead', context({ status: 'dead' }), 'STOP'],
    ['interested', context({ status: 'interested' }), 'STOP'], ['negotiating', context({ status: 'negotiating' }), 'STOP'],
    ['manual review', context({ manualOverride: { requestedStatus: 'closed_manual' } }), 'MANUAL_REVIEW'],
    ['unsubscribe', context({ status: 'replied', reply: { received: true, classification: 'UNSUBSCRIBE' } }), 'STOP'],
  ] as const) assert.equal(decideNextAction(value).action, action, label)

  const replyHarness = harness({ contexts: [context({ status: 'replied', reply: { received: true, classification: 'INTERESTED' } })] })
  assert.equal((await orchestrateLead(request(), replyHarness.deps)).stoppedBecause, 'HANDOFF_REPLY')
}

async function testLoopRetryConcurrencyAndShadow() {
  const noChangeExecutors = createExecutorRegistry({
    research: async () => ({ outcome: 'completed', changedState: false }), initialContent: async () => ({ outcome: 'completed', changedState: false }),
    initialSend: async () => ({ outcome: 'completed', changedState: false }), followUp: async () => ({ outcome: 'completed', changedState: false }),
    reactivation: async () => ({ outcome: 'completed', changedState: false }), lifecycle: async () => ({ outcome: 'completed', changedState: false }),
  })
  assert.equal((await orchestrateLead(request(), harness({ contexts: [context()], executors: noChangeExecutors }).deps)).stoppedBecause, 'NO_STATE_CHANGE')
  assert.equal((await orchestrateLead(request(), harness({ contexts: [context(), context()] }).deps)).stoppedBecause, 'LOOP_GUARD')

  let version = 0
  const maxHarness = harness({ contexts: [context()], decide: (value) => ({ action: 'RESEARCH', reasonCode: 'PERSONALIZED_RESEARCH_REQUIRED', leadId: value.leadId, inputsUsed: [], metadata: { version: version++ } }) })
  maxHarness.deps.loadContext = async () => context({ email: `v${version}@example.test` })
  assert.equal((await orchestrateLead({ ...request(), maxIterations: 2 }, maxHarness.deps)).stoppedBecause, 'MAX_ITERATIONS')

  const throwing = harness({ contexts: [context()], executors: { RESEARCH: async () => { throw new Error('transient') } } })
  const failed = await orchestrateLead(request(), throwing.deps)
  assert.equal(failed.stoppedBecause, 'EXECUTOR_FAILED')
  assert.equal(failed.retryable, true)

  for (const retryState of [
    context({ status: 'researched', research: { contactDiscoveryComplete: true, personalisationComplete: true, canSupplyTemplateFields: true } }),
    context({ status: 'email_ready', initialEmail: { state: 'pending', sentAt: null } }),
    contactedContext(1),
  ]) assert.notEqual(decideNextAction(retryState).action, 'RESEARCH', 'retry does not repeat completed research')

  const shadowHarness = harness({ contexts: [context()] })
  const shadow = await orchestrateLead({ ...request(), shadow: true }, shadowHarness.deps)
  assert.equal(shadow.stoppedBecause, 'SHADOW')
  assert.equal(shadowHarness.calls(), 0, 'shadow calls zero executors')

  let held = false
  let releaseFirst!: () => void
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const concurrencyHarness = harness({ contexts: [context()], acquire: async () => held ? null : (held = true, 'token') })
  concurrencyHarness.deps.executors = { RESEARCH: async () => { await gate; return { outcome: 'completed', changedState: false } } }
  const first = orchestrateLead(request(), concurrencyHarness.deps)
  await Promise.resolve()
  const second = await orchestrateLead(request(), concurrencyHarness.deps)
  assert.equal(second.stoppedBecause, 'CONCURRENT_EXECUTION')
  releaseFirst()
  await first

  assert.deepEqual(readOrchestratorFlags({} as NodeJS.ProcessEnv), { enabled: false, shadow: false })
}

async function testMappingBatchAndPerformance() {
  const noop = async () => ({ outcome: 'completed' as const, changedState: true })
  const registry = createExecutorRegistry({ research: noop, initialContent: noop, initialSend: noop, followUp: noop, reactivation: noop, lifecycle: noop })
  const expected: DecisionAction[] = ['RESEARCH', 'GENERATE_INITIAL', 'SEND_INITIAL', 'SEND_FOLLOWUP_1', 'SEND_FOLLOWUP_2', 'SEND_FOLLOWUP_3', 'REACTIVATE', 'MARK_DEAD']
  for (const action of expected) assert.equal(typeof registry[action], 'function', `${action} mapped centrally`)
  assert.equal(decisionStateFingerprint(context()), decisionStateFingerprint({ ...context(), asOf: '2030-01-01T00:00:00.000Z' }), 'volatile asOf excluded')

  let active = 0; let peak = 0
  const batch = await orchestrateLeadBatch(Array.from({ length: 12 }, (_, index) => request(`lead-${index}`)), async (item) => {
    active++; peak = Math.max(peak, active); await Promise.resolve(); active--
    return { leadId: item.leadId, workflowRunId: null, status: 'succeeded', finalAction: null, finalReasonCode: null, actionsExecuted: [], iterationCount: 0, stoppedBecause: 'STOP', retryable: false }
  }, 3)
  assert.equal(batch.results.length, 12)
  assert.ok(peak <= 3, 'batch concurrency is bounded')
  await assert.rejects(() => orchestrateLeadBatch(Array.from({ length: 101 }, (_, index) => request(`lead-${index}`)), async () => batch.results[0]), /exceeds 100/)

  const started = performance.now()
  for (let index = 0; index < 100; index++) decideNextAction(contactedContext(index % 61))
  console.log(JSON.stringify({ representativePureDecisionCount: 100, durationMs: Number((performance.now() - started).toFixed(3)), slaPromise: false }))
}

function testStaticBoundaries() {
  const root = process.cwd()
  const daily = readFileSync(resolve(root, 'trigger/daily-pipeline.ts'), 'utf8')
  const envExample = readFileSync(resolve(root, '.env.v2.example'), 'utf8')
  const core = readFileSync(resolve(root, 'src/domain/orchestrator/orchestrate-lead.ts'), 'utf8')
  const mapping = readFileSync(resolve(root, 'src/domain/orchestrator/executor-map.ts'), 'utf8')
  const observation = readFileSync(resolve(root, 'src/lib/observability/service.ts'), 'utf8')
  assert.ok(daily.includes('queue:') && daily.includes('concurrencyLimit: 1'), 'Trigger concurrency remains in Trigger.dev')
  assert.ok(daily.indexOf('runFinderAgent()') < daily.indexOf('const leadIds = await selectOrchestrationCandidateIds'), 'Finder remains before lead orchestration')
  assert.ok(daily.includes('orchestratorFlags.enabled && !orchestratorFlags.shadow'), 'shadow takes precedence over enabled execution')
  assert.match(envExample, /ORCHESTRATOR_ENABLED=false/)
  assert.match(envExample, /ORCHESTRATOR_SHADOW=false/)
  assert.ok(!core.includes('/ai/') && !mapping.includes('/ai/'), 'routing core has no AI dependency')
  assert.ok(observation.includes('decision_action: input.decision?.action'), 'decision steps use Prompt 10 observability columns')
  assert.deepEqual(readdirSync(resolve(root, 'supabase-v2/migrations')).sort(), [
    '00000000000000_reachagent_v2_golden_baseline.sql',
    '00000000000001_performance_reliability.sql',
    '00000000000002_observability_foundation.sql',
  ], 'Prompt 11 adds or edits no database migration')
}

async function main() {
  await testTemplateAndPersonalizedPaths()
  await testFollowUpReactivationAndSafety()
  await testLoopRetryConcurrencyAndShadow()
  await testMappingBatchAndPerformance()
  testStaticBoundaries()
  console.log('REACHAGENT_V2_ORCHESTRATOR_TEST_PASS')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
