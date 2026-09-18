import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  compareDecisionWithLegacy,
  compareDecisionWithLifecycleProjection,
  decideNextAction,
  isLifecycleTransitionAllowed,
  loadDecisionContexts,
  MAX_DECISION_CONTEXT_BATCH,
  type DecisionAction,
  type LeadDecisionContext,
} from '../src/domain/decision-engine'
import { createServiceClient } from '../src/lib/supabase/server'

const NOW = '2026-09-15T00:00:00.000Z'
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString()
const missing = () => ({ state: 'missing' as const, sentAt: null })
const pending = () => ({ state: 'pending' as const, sentAt: null })
const sent = (days: number) => ({ state: 'sent' as const, sentAt: daysAgo(days) })

type ContextOverrides = Partial<Omit<LeadDecisionContext, 'research' | 'template' | 'initialEmail' | 'followUps' | 'reply' | 'reactivation' | 'schedule'>> & {
  research?: Partial<LeadDecisionContext['research']>
  template?: Partial<LeadDecisionContext['template']>
  initialEmail?: Partial<LeadDecisionContext['initialEmail']>
  followUps?: Partial<LeadDecisionContext['followUps']>
  reply?: Partial<LeadDecisionContext['reply']>
  reactivation?: Partial<LeadDecisionContext['reactivation']>
  schedule?: Partial<LeadDecisionContext['schedule']>
}

function context(overrides: ContextOverrides = {}): LeadDecisionContext {
  const base: LeadDecisionContext = {
    leadId: randomUUID(), status: 'new', email: 'hello@example.com', duplicate: false, suppressed: false,
    dealState: 'none', initialEmailMode: 'ai_personalised',
    research: { contactDiscoveryComplete: true, personalisationComplete: false, canSupplyTemplateFields: false },
    template: { available: false, requiredDataAvailable: false }, initialEmail: missing(),
    followUps: { followUp1: missing(), followUp2: missing(), followUp3: missing() },
    reply: { received: false, classification: null }, reactivation: { enabled: true, sentAt: null },
    schedule: { followUp1Days: 7, followUp2Days: 14, followUp3Days: 21, deadLeadDays: 21, reactivationDelayDays: 60, deadAfterReactivationDays: 14 },
    asOf: NOW, manualOverride: null,
    operationalFacts: { categoryIdPresent: true, hasUsableCategoryContext: true, manualSource: false, recipientOwnership: 'unclaimed', openDuplicateFlag: false },
  }
  return {
    ...base, ...overrides,
    research: { ...base.research, ...overrides.research }, template: { ...base.template, ...overrides.template },
    initialEmail: { ...base.initialEmail, ...overrides.initialEmail }, followUps: { ...base.followUps, ...overrides.followUps },
    reply: { ...base.reply, ...overrides.reply }, reactivation: { ...base.reactivation, ...overrides.reactivation },
    schedule: { ...base.schedule, ...overrides.schedule },
  }
}

async function main(): Promise<void> {
const nullCategoryFacts: NonNullable<LeadDecisionContext['operationalFacts']> = {
  categoryIdPresent: false,
  hasUsableCategoryContext: false,
  manualSource: false,
  recipientOwnership: 'unclaimed',
  openDuplicateFlag: false,
}
const orphanedCategoryFacts: NonNullable<LeadDecisionContext['operationalFacts']> = {
  ...nullCategoryFacts,
  categoryIdPresent: true,
}
const cases: Array<{ name: string; context: LeadDecisionContext; action: DecisionAction; reason?: string }> = [
  { name: 'new template lead with sufficient data', context: context({ initialEmailMode: 'template', template: { available: true, requiredDataAvailable: true } }), action: 'GENERATE_INITIAL', reason: 'TEMPLATE_READY' },
  { name: 'template lead missing researchable required data', context: context({ initialEmailMode: 'template', template: { available: true, requiredDataAvailable: false }, research: { canSupplyTemplateFields: true } }), action: 'RESEARCH', reason: 'TEMPLATE_RESEARCH_REQUIRED' },
  { name: 'template lead missing unresearchable required data', context: context({ initialEmailMode: 'template', template: { available: true, requiredDataAvailable: false } }), action: 'MANUAL_REVIEW', reason: 'TEMPLATE_DATA_UNAVAILABLE' },
  { name: 'template missing configuration', context: context({ initialEmailMode: 'template', template: { available: false } }), action: 'MANUAL_REVIEW', reason: 'TEMPLATE_CONFIGURATION_INVALID' },
  { name: 'template new lead missing email', context: context({ initialEmailMode: 'template', email: null, research: { contactDiscoveryComplete: false } }), action: 'RESEARCH' },
  { name: 'new personalized lead', context: context(), action: 'RESEARCH', reason: 'PERSONALIZED_RESEARCH_REQUIRED' },
  { name: 'researched personalized lead', context: context({ status: 'researched', research: { personalisationComplete: true } }), action: 'GENERATE_INITIAL' },
  { name: 'email ready lead', context: context({ status: 'email_ready', research: { personalisationComplete: true }, initialEmail: pending() }), action: 'SEND_INITIAL', reason: 'INITIAL_CONTENT_READY' },
  { name: 'duplicate pending content is sent not regenerated', context: context({ status: 'email_ready', initialEmail: pending() }), action: 'SEND_INITIAL' },
  { name: 'contacted before FU1 due', context: context({ status: 'contacted', initialEmail: sent(6), operationalFacts: nullCategoryFacts }), action: 'WAIT', reason: 'FOLLOWUP_NOT_DUE' },
  { name: 'valid category and FU1 eligible', context: context({ status: 'contacted', initialEmail: sent(7) }), action: 'SEND_FOLLOWUP_1', reason: 'FOLLOWUP_1_READY' },
  { name: 'null category and FU1 eligible', context: context({ status: 'contacted', initialEmail: sent(7), operationalFacts: nullCategoryFacts }), action: 'MANUAL_REVIEW', reason: 'CATEGORY_CONTEXT_REQUIRED' },
  { name: 'orphaned category and FU1 eligible', context: context({ status: 'contacted', initialEmail: sent(7), operationalFacts: orphanedCategoryFacts }), action: 'MANUAL_REVIEW', reason: 'CATEGORY_CONTEXT_REQUIRED' },
  { name: 'FU1 sent before FU2', context: context({ status: 'contacted', initialEmail: sent(10), followUps: { followUp1: sent(3) } }), action: 'WAIT' },
  { name: 'valid category and FU2 eligible', context: context({ status: 'contacted', initialEmail: sent(14), followUps: { followUp1: sent(7) } }), action: 'SEND_FOLLOWUP_2', reason: 'FOLLOWUP_2_READY' },
  { name: 'null category and FU2 eligible', context: context({ status: 'contacted', initialEmail: sent(14), followUps: { followUp1: sent(7) }, operationalFacts: nullCategoryFacts }), action: 'MANUAL_REVIEW', reason: 'CATEGORY_CONTEXT_REQUIRED' },
  { name: 'valid category and FU3 eligible', context: context({ status: 'contacted', initialEmail: sent(21), followUps: { followUp1: sent(14), followUp2: sent(7) } }), action: 'SEND_FOLLOWUP_3', reason: 'FOLLOWUP_3_READY' },
  { name: 'null category and FU3 eligible', context: context({ status: 'contacted', initialEmail: sent(21), followUps: { followUp1: sent(14), followUp2: sent(7) }, operationalFacts: nullCategoryFacts }), action: 'MANUAL_REVIEW', reason: 'CATEGORY_CONTEXT_REQUIRED' },
  { name: 'reply received', context: context({ status: 'contacted', initialEmail: sent(2), reply: { received: true, classification: 'INFO_REQUEST' } }), action: 'HANDLE_REPLY', reason: 'REPLY_RECEIVED' },
  { name: 'reply needs future classifier', context: context({ status: 'replied', reply: { received: true, classification: null } }), action: 'HANDLE_REPLY', reason: 'REPLY_CLASSIFICATION_REQUIRED' },
  { name: 'interested', context: context({ status: 'interested' }), action: 'STOP', reason: 'ACTIVE_DEAL_STATUS' },
  { name: 'negotiating', context: context({ status: 'negotiating' }), action: 'STOP', reason: 'ACTIVE_DEAL_STATUS' },
  { name: 'closed', context: context({ status: 'closed' }), action: 'STOP', reason: 'TERMINAL_STATUS' },
  { name: 'closed manual', context: context({ status: 'closed_manual' }), action: 'STOP', reason: 'TERMINAL_STATUS' },
  { name: 'dead', context: context({ status: 'dead' }), action: 'STOP', reason: 'TERMINAL_STATUS' },
  { name: 'late reply on dead lead', context: context({ status: 'dead', reply: { received: true, classification: 'UNCLEAR' } }), action: 'HANDLE_REPLY' },
  { name: 'suppression', context: context({ suppressed: true, status: 'contacted', initialEmail: sent(20) }), action: 'STOP', reason: 'SUPPRESSED' },
  { name: 'unsubscribe', context: context({ status: 'contacted', reply: { received: true, classification: 'UNSUBSCRIBE' }, initialEmail: sent(2) }), action: 'STOP', reason: 'UNSUBSCRIBED' },
  { name: 'out of office', context: context({ status: 'contacted', reply: { received: true, classification: 'OUT_OF_OFFICE' }, initialEmail: sent(2) }), action: 'WAIT', reason: 'OUT_OF_OFFICE' },
  { name: 'missing email after research', context: context({ status: 'researched', email: null, research: { personalisationComplete: true } }), action: 'STOP', reason: 'MISSING_EMAIL' },
  { name: 'reactivation not due without category remains waiting', context: context({ status: 'contacted', initialEmail: sent(59), followUps: { followUp1: sent(52), followUp2: sent(45), followUp3: sent(38) }, operationalFacts: nullCategoryFacts }), action: 'WAIT', reason: 'REACTIVATION_NOT_DUE' },
  { name: 'valid category and reactivation eligible', context: context({ status: 'contacted', initialEmail: sent(60), followUps: { followUp1: sent(53), followUp2: sent(46), followUp3: sent(39) } }), action: 'REACTIVATE', reason: 'REACTIVATION_READY' },
  { name: 'null category and reactivation eligible', context: context({ status: 'contacted', initialEmail: sent(60), followUps: { followUp1: sent(53), followUp2: sent(46), followUp3: sent(39) }, operationalFacts: nullCategoryFacts }), action: 'MANUAL_REVIEW', reason: 'CATEGORY_CONTEXT_REQUIRED' },
  { name: 'contacted template-ready lead never regenerates initial', context: context({ status: 'contacted', initialEmailMode: 'template', template: { available: true, requiredDataAvailable: true }, initialEmail: sent(6) }), action: 'WAIT', reason: 'FOLLOWUP_NOT_DUE' },
  { name: 'suppression wins over missing category', context: context({ suppressed: true, status: 'contacted', initialEmail: sent(7), operationalFacts: nullCategoryFacts }), action: 'STOP', reason: 'SUPPRESSED' },
  { name: 'duplicate wins over missing category', context: context({ duplicate: true, status: 'contacted', initialEmail: sent(7), operationalFacts: nullCategoryFacts }), action: 'STOP', reason: 'DUPLICATE_LEAD' },
  { name: 'reply handling wins over missing category', context: context({ status: 'contacted', initialEmail: sent(7), reply: { received: true, classification: 'INFO_REQUEST' }, operationalFacts: nullCategoryFacts }), action: 'HANDLE_REPLY', reason: 'REPLY_RECEIVED' },
  { name: 'follow-up uncertainty wins over missing category', context: context({ status: 'contacted', initialEmail: sent(14), followUps: { followUp1: { state: 'uncertain', sentAt: null } }, operationalFacts: nullCategoryFacts }), action: 'MANUAL_REVIEW', reason: 'FOLLOWUP_SEND_UNCERTAIN' },
  { name: 'already reactivated', context: context({ status: 'contacted', initialEmail: sent(70), followUps: { followUp1: sent(63), followUp2: sent(56), followUp3: sent(49) }, reactivation: { sentAt: daysAgo(13) } }), action: 'WAIT', reason: 'REACTIVATION_ALREADY_SENT' },
  { name: 'post-reactivation deadline', context: context({ status: 'contacted', initialEmail: sent(80), followUps: { followUp1: sent(73), followUp2: sent(66), followUp3: sent(59) }, reactivation: { sentAt: daysAgo(14) } }), action: 'MARK_DEAD', reason: 'REACTIVATION_DEADLINE_REACHED' },
  { name: 'manual override requires executor review', context: context({ status: 'researched', research: { personalisationComplete: true }, manualOverride: { requestedStatus: 'closed_manual' } }), action: 'MANUAL_REVIEW', reason: 'MANUAL_OVERRIDE_REQUIRED' },
  { name: 'uncertain initial send is never resent blindly', context: context({ status: 'email_ready', initialEmail: { state: 'uncertain', sentAt: null } }), action: 'MANUAL_REVIEW', reason: 'INITIAL_SEND_UNCERTAIN' },
  { name: 'duplicate finder candidate', context: context({ duplicate: true }), action: 'STOP', reason: 'DUPLICATE_LEAD' },
]

for (const testCase of cases) {
  const decision = decideNextAction(testCase.context)
  assert.equal(decision.action, testCase.action, testCase.name)
  if (testCase.reason) assert.equal(decision.reasonCode, testCase.reason, testCase.name)
  assert.equal(decision.leadId, testCase.context.leadId)
  assert.ok(decision.inputsUsed.length > 0, `${testCase.name}: inputsUsed`)
}

assert.equal(isLifecycleTransitionAllowed('new', 'researched', 'automated'), true)
assert.equal(isLifecycleTransitionAllowed('dead', 'replied', 'automated'), true)
assert.equal(isLifecycleTransitionAllowed('closed', 'new', 'manual'), false)
assert.equal(isLifecycleTransitionAllowed('contacted', 'closed_manual', 'automated'), false)
assert.equal(isLifecycleTransitionAllowed('contacted', 'closed_manual', 'manual'), true)

const caseNamed = (name: string) => cases.find((item) => item.name === name)!.context
const templateShadow = compareDecisionWithLegacy(caseNamed('new template lead with sufficient data'))
assert.equal(templateShadow.legacyAction, 'RESEARCH')
assert.equal(templateShadow.engine.action, 'GENERATE_INITIAL')
assert.equal(templateShadow.classification, 'EXPECTED_V2_CONSOLIDATION')
assert.equal(compareDecisionWithLegacy(caseNamed('new personalized lead')).classification, 'MATCH')
assert.equal(compareDecisionWithLegacy(caseNamed('uncertain initial send is never resent blindly')).classification, 'MATCH')
assert.equal(compareDecisionWithLifecycleProjection(caseNamed('contacted before FU1 due'), { next_action: 'Send Follow-up 1', is_overdue: false }).classification, 'MATCH')

for (const file of ['agents/researcher.ts', 'agents/sender.ts', 'agents/followup.ts', 'agents/reactivation.ts']) {
  const source = await readFile(file, 'utf8')
  assert.match(source, /@\/domain\/decision-engine/, `${file} must use the central Decision Engine`)
}

assert.equal(MAX_DECISION_CONTEXT_BATCH, 100)
await assert.rejects(() => loadDecisionContexts(createServiceClient(), Array.from({ length: 101 }, () => randomUUID())), /exceeds 100/)

const supabase = createServiceClient()
const fixtureIds = [randomUUID(), randomUUID()]
const categoryName = `Decision Fixture ${randomUUID()}`
let categoryId: string | null = null
try {
  const categoryResult = await supabase.from('categories').insert({ name: categoryName, status: 'active' }).select('id').single()
  assert.equal(categoryResult.error, null)
  categoryId = categoryResult.data!.id
  const { error: leadError } = await supabase.from('leads').insert([
    { id: fixtureIds[0], business_name: 'Decision Fixture New', category_name: 'Synthetic', city: 'Sydney', status: 'new', email: 'decision-new@example.test' },
    { id: fixtureIds[1], business_name: 'Decision Fixture Ready', category_id: categoryId, category_name: 'Synthetic', city: 'Sydney', status: 'email_ready', email: 'decision-ready@example.test' },
  ])
  assert.equal(leadError, null)
  const { error: emailError } = await supabase.from('emails').insert({
    lead_id: fixtureIds[1], type: 'initial_pitch', subject: 'Synthetic', body_html: '<p>Synthetic</p>', body_text: 'Synthetic', status: 'pending_send',
  })
  assert.equal(emailError, null)
  const loaded = await loadDecisionContexts(supabase, fixtureIds, { asOf: NOW, initialEmailMode: 'ai_personalised' })
  assert.equal(loaded.contexts.length, 2)
  assert.deepEqual(loaded.missingLeadIds, [])
  assert.ok(loaded.metrics.databaseCalls <= 6)
  assert.equal(loaded.metrics.requestedLeadCount, 2)
  assert.equal(loaded.metrics.maxBatchSize, 100)
  assert.equal(loaded.contexts.find((item) => item.leadId === fixtureIds[0])!.operationalFacts?.hasUsableCategoryContext, false)
  assert.equal(loaded.contexts.find((item) => item.leadId === fixtureIds[1])!.operationalFacts?.hasUsableCategoryContext, true)
  assert.equal(decideNextAction(loaded.contexts.find((item) => item.leadId === fixtureIds[1])!).action, 'SEND_INITIAL')
} finally {
  await supabase.from('leads').delete().in('id', fixtureIds)
  if (categoryId) await supabase.from('categories').delete().eq('id', categoryId)
}

console.log(JSON.stringify({
  status: 'PASS', pureDecisionCases: cases.length, transitionAssertions: 5,
  shadowComparisons: 4, integratedExecutionPaths: 5, boundedContextBatch: MAX_DECISION_CONTEXT_BATCH,
}, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
