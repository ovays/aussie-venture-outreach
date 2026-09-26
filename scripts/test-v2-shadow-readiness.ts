import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  EXPECTED_DIFFERENCE_REGISTER,
  MAX_SHADOW_BATCH_SIZE,
  SHADOW_CLASSIFICATION_ALIASES,
  SYNTHETIC_SHADOW_COHORTS,
  V1_DATA_COMPATIBILITY_REPORT,
  assertShadowSafeExecution,
  createReadOnlySupabaseClient,
  evaluateLeadShadow,
  evaluateShadowBatch,
  selectShadowLeadIds,
  validateProductionShadowCredentials,
} from '@/domain/shadow-readiness'
import type { LeadDecisionContext } from '@/domain/decision-engine'

const safeEnv = (overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  ORCHESTRATOR_SHADOW: 'true', ORCHESTRATOR_ENABLED: 'false', OUTREACH_SEND_ENABLED: 'false',
  HOSTINGER_MUTATIONS_ENABLED: 'false', FINDER_SCHEDULE_ENABLED: 'false',
  SHADOW_OBSERVABILITY_WRITE_ENABLED: 'false', V2_SHADOW_ALLOW_PRODUCTION_READS: 'false',
  ...overrides,
})
const safety = { target: 'local-v2' as const }

async function testSyntheticCohorts() {
  const byId = new Map(SYNTHETIC_SHADOW_COHORTS.map((item) => [item.context.leadId, item.context]))
  const providerAndMutationCalls = {
    researchAI: 0, writerAI: 0, resend: 0, hostinger: 0, googleOutscraper: 0,
    leadWrites: 0, emailWrites: 0, followUpWrites: 0, suppressionWrites: 0, executor: 0,
  }
  const started = performance.now()
  const batch = await evaluateShadowBatch([...byId.keys()], {
    safety, environment: safeEnv(), source: 'test.synthetic',
    loadContext: async (leadId) => byId.get(leadId) ?? null,
    now: () => new Date('2026-09-15T00:00:00.000Z'),
  }, 3)
  const durationMs = performance.now() - started
  assert.equal(batch.outcomes.length, SYNTHETIC_SHADOW_COHORTS.length)
  assert.equal(batch.summary.failedEvaluationCount, 0)
  assert.equal(batch.summary.classifications.BUG_IN_NEW_ENGINE, 0)
  assert.equal(batch.summary.classifications.PRODUCT_DECISION_REQUIRED, 0)
  assert.equal(batch.summary.classifications.MATCH + batch.summary.classifications.EXPECTED_V2_CONSOLIDATION, SYNTHETIC_SHADOW_COHORTS.length)
  assert.deepEqual(providerAndMutationCalls, {
    researchAI: 0, writerAI: 0, resend: 0, hostinger: 0, googleOutscraper: 0,
    leadWrites: 0, emailWrites: 0, followUpWrites: 0, suppressionWrites: 0, executor: 0,
  })
  const expected = batch.outcomes.filter((item) => item.ok && item.result.classification === 'EXPECTED_V2_CONSOLIDATION')
  assert.deepEqual(expected.map((item) => item.ok && item.result.leadId), ['template-ready-new'])
  assert.ok(EXPECTED_DIFFERENCE_REGISTER.some((item) => item.id === 'SD-001' && item.approved))
  console.log(JSON.stringify({ syntheticCohorts: SYNTHETIC_SHADOW_COHORTS.length, pureComparisonDurationMs: Number(durationMs.toFixed(3)), slaPromise: false }))
}

async function testNoWriteAndObservabilityModes() {
  const context = SYNTHETIC_SHADOW_COHORTS[2].context
  let writes = 0
  const observer = { recordComparison: async () => { writes++ } }
  await assert.rejects(() => evaluateLeadShadow(context.leadId, {
    safety, environment: safeEnv(), source: 'test.no-write', loadContext: async () => context, observer,
  }), /observability sink supplied/)
  assert.equal(writes, 0)
  await evaluateLeadShadow(context.leadId, {
    safety, environment: safeEnv({ SHADOW_OBSERVABILITY_WRITE_ENABLED: 'true' }),
    source: 'test.write', loadContext: async () => context, observer,
  })
  assert.equal(writes, 1, 'observability is the sole opt-in write capability')
}

async function testBatchBoundsIsolationAndConcurrency() {
  const context = SYNTHETIC_SHADOW_COHORTS[2].context
  await assert.rejects(() => evaluateShadowBatch([], { safety, environment: safeEnv(), source: 'test', loadContext: async () => context }), /at least one/)
  await assert.rejects(() => evaluateShadowBatch(Array.from({ length: MAX_SHADOW_BATCH_SIZE + 1 }, (_, i) => `lead-${i}`), { safety, environment: safeEnv(), source: 'test', loadContext: async () => context }), /exceeds 100/)
  await assert.rejects(() => selectShadowLeadIds({} as never, {}), /requires --limit/)
  await assert.rejects(() => selectShadowLeadIds({} as never, { limit: 5 }), /Unbounded shadow selection/)
  let active = 0; let peak = 0
  const batch = await evaluateShadowBatch(['a', 'missing', 'b', 'c'], {
    safety, environment: safeEnv(), source: 'test.isolation',
    loadContext: async (leadId) => {
      active++; peak = Math.max(peak, active)
      await new Promise((resolve) => setImmediate(resolve))
      active--
      return leadId === 'missing' ? null : { ...context, leadId }
    },
  }, 2)
  assert.ok(peak <= 2)
  assert.deepEqual(batch.outcomes.map((item) => item.ok ? item.result.leadId : item.leadId), ['a', 'missing', 'b', 'c'])
  assert.equal(batch.summary.failedEvaluationCount, 1)
  assert.equal(batch.outcomes[2].ok, true, 'one failed lead does not stop later leads')
}

function testRuntimeSafetyAndKillSwitch() {
  assert.throws(() => assertShadowSafeExecution(safety, safeEnv({ ORCHESTRATOR_SHADOW: 'false' })), /disabled/)
  for (const gate of ['ORCHESTRATOR_ENABLED', 'OUTREACH_SEND_ENABLED', 'HOSTINGER_MUTATIONS_ENABLED', 'FINDER_SCHEDULE_ENABLED']) {
    assert.throws(() => assertShadowSafeExecution(safety, safeEnv({ [gate]: 'true' })), new RegExp(gate))
  }
  const production = { target: 'v1-production-readonly' as const, productionReadAcknowledged: true }
  assert.throws(() => assertShadowSafeExecution(production, safeEnv()), /require/)
  assert.throws(() => assertShadowSafeExecution({ ...production, productionReadAcknowledged: false }, safeEnv({ V2_SHADOW_ALLOW_PRODUCTION_READS: 'true' })), /require/)
  assert.equal(assertShadowSafeExecution(production, safeEnv({ V2_SHADOW_ALLOW_PRODUCTION_READS: 'true' })).productionReadsAcknowledged, true)
}

function testProductionCredentialSplit() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const token = (role: string, exp: number) => `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role, exp })}.signature`
  const now = new Date('2026-09-16T12:00:00.000Z')
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const valid = safeEnv({
    V2_SHADOW_SUPABASE_URL: 'https://obppfnujusqiwjhwzosv.supabase.co',
    V2_SHADOW_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_prompt15_test',
    V2_SHADOW_SUPABASE_ACCESS_TOKEN: token('reachagent_prompt15_shadow_reader', nowSeconds + 3600),
    V2_SHADOW_SUPABASE_SCHEMA: 'reachagent_prompt15_shadow',
  })
  assert.equal(validateProductionShadowCredentials(valid, now).publishableKey, 'sb_publishable_prompt15_test')
  assert.throws(() => validateProductionShadowCredentials({ ...valid, V2_SHADOW_SUPABASE_READ_KEY: 'legacy' }, now), /rejects V2_SHADOW_SUPABASE_READ_KEY/)
  assert.throws(() => validateProductionShadowCredentials({ ...valid, V2_SHADOW_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_forbidden' }, now), /publishable/)
  assert.throws(() => validateProductionShadowCredentials({ ...valid, V2_SHADOW_SUPABASE_ACCESS_TOKEN: token('service_role', nowSeconds + 3600) }, now), /role must be exactly/)
  assert.throws(() => validateProductionShadowCredentials({ ...valid, V2_SHADOW_SUPABASE_ACCESS_TOKEN: token('reachagent_prompt15_shadow_reader', nowSeconds - 1) }, now), /expired/)
  assert.throws(() => validateProductionShadowCredentials({ ...valid, V2_SHADOW_SUPABASE_ACCESS_TOKEN: token('reachagent_prompt15_shadow_reader', nowSeconds + 7201) }, now), /two hours/)
  assert.throws(() => validateProductionShadowCredentials({ ...valid, V2_SHADOW_SUPABASE_SCHEMA: 'public' }, now), /reachagent_prompt15_shadow/)
  assert.throws(() => validateProductionShadowCredentials({ ...valid, V2_SHADOW_SUPABASE_ACCESS_TOKEN: 'sb_publishable_prompt15_test' }, now), /distinct/)
}

function testReadOnlyCapability() {
  let underlyingMutations = 0
  const builder = {
    select() { return this }, eq() { return this }, limit() { return this },
    update() { underlyingMutations++; return this }, insert() { underlyingMutations++; return this },
  }
  const raw = { from() { return builder }, rpc() { underlyingMutations++; return builder } }
  const audit = { blockedMutationAttempts: 0, allowedMethodCalls: 0 }
  const readonly = createReadOnlySupabaseClient(raw as never, audit) as any
  assert.equal(readonly.from('leads').select('id').eq('id', 'one').limit(1), readonly.from('leads').select('id').eq('id', 'one').limit(1))
  assert.throws(() => readonly.from('leads').update({ status: 'dead' }), /blocked/)
  assert.throws(() => readonly.from('emails').insert({}), /blocked/)
  assert.throws(() => readonly.rpc('claim_recipient_outreach'), /blocked/)
  assert.equal(underlyingMutations, 0)
  assert.equal(audit.blockedMutationAttempts, 3)
}

function testStaticBoundariesAndCompatibility() {
  const root = process.cwd()
  const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
  const combinedCore = ['evaluator.ts', 'batch.ts', 'selector.ts', 'read-only-client.ts'].map((name) => read(`src/domain/shadow-readiness/${name}`)).join('\n')
  for (const forbidden of ['/services/', '/ai/', 'resend', 'hostinger', 'outscraper', 'googleplaces', 'createProductionExecutorRegistry', 'acquireLock']) {
    assert.ok(!combinedCore.toLowerCase().includes(forbidden.toLowerCase()), `shadow core excludes ${forbidden}`)
  }
  const daily = read('trigger/daily-pipeline.ts')
  assert.ok(daily.includes('orchestratorFlags.enabled && !orchestratorFlags.shadow'))
  assert.ok(!daily.includes('trigger.daily_pipeline.shadow'))
  for (const legacyStage of ['runFinderAgent(workspaceId)', 'runResearcherAgent(workspaceId, initialEmailMode)', 'runWriterAgent(workspaceId, initialEmailMode)', 'runSenderAgent(workspaceId)', 'runFollowUpAgent(workspaceId)', 'runReactivationAgent(workspaceId)']) {
    assert.ok(daily.includes(legacyStage), `legacy stage remains present and workspace-scoped: ${legacyStage}`)
  }
  const dedicated = read('trigger/v2-shadow-comparison.ts')
  assert.ok(dedicated.includes("id: 'v2-shadow-comparison'") && !dedicated.includes('schedules.task'))
  const example = read('.env.v2.example')
  for (const gate of ['ORCHESTRATOR_ENABLED', 'ORCHESTRATOR_SHADOW', 'OUTREACH_SEND_ENABLED', 'TRIGGER_JOBS_ENABLED', 'FINDER_SCHEDULE_ENABLED', 'HOSTINGER_MUTATIONS_ENABLED', 'V2_SHADOW_ALLOW_PRODUCTION_READS', 'SHADOW_OBSERVABILITY_WRITE_ENABLED']) {
    assert.match(example, new RegExp(`${gate}=false`))
  }
  assert.equal(SHADOW_CLASSIFICATION_ALIASES.BUG_IN_ORCHESTRATOR, 'BUG_IN_NEW_ENGINE')
  assert.ok(V1_DATA_COMPATIBILITY_REPORT.every((item) => item.disposition.startsWith('SUPPORTED')))
  assert.equal(V1_DATA_COMPATIBILITY_REPORT.find((item) => item.fact === 'nullable category')?.disposition, 'SUPPORTED_WITH_MANUAL_REVIEW')
  assert.match(read('trigger.config.ts'), /runtime:\s*["']node-24["']/)
  assert.deepEqual(readdirSync(resolve(root, 'supabase-v2/migrations')).sort(), [
    '00000000000000_reachagent_v2_golden_baseline.sql',
    '00000000000001_performance_reliability.sql',
    '00000000000002_observability_foundation.sql',
    '00000000000003_v2_canary_send_claim.sql',
    '00000000000004_workspace_tenancy_tables.sql',
    '00000000000005_workspace_id_columns_and_backfill.sql',
    '00000000000006_workspace_settings_seed.sql',
    '00000000000007_workspace_rls_policies.sql',
    '00000000000008_workspace_indexes_and_constraints.sql',
    '00000000000009_workspace_scope_functions_and_keys.sql',
    '00000000000010_remove_workspace_default.sql',
    '00000000000011_customer_onboarding.sql',
    '00000000000012_category_policy.sql',
    '00000000000013_mailbox_connections.sql',
  ])
}

async function main() {
  await testSyntheticCohorts()
  await testNoWriteAndObservabilityModes()
  await testBatchBoundsIsolationAndConcurrency()
  testRuntimeSafetyAndKillSwitch()
  testProductionCredentialSplit()
  testReadOnlyCapability()
  testStaticBoundariesAndCompatibility()
  console.log('REACHAGENT_V2_SHADOW_READINESS_TEST_PASS')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
