import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import {
  evaluateCategoryPolicy,
  normalizeCategoryPolicyFacts,
  type CategoryPolicy,
  type CategoryPolicyFacts,
} from '../src/domain/category-policy'
import { decideNextAction, loadDecisionContext, type LeadDecisionContext } from '../src/domain/decision-engine'
import { orchestrateLead, type OrchestratorDependencies } from '../src/domain/orchestrator'
import type { Database } from '../src/types/database'
import { categoryFieldsSchema } from '../src/lib/category-api-schema'

const policy = (overrides: Partial<CategoryPolicy> = {}): CategoryPolicy => ({
  requiresHalalConfirmation: false,
  excludeAlcoholFocused: false,
  excludePork: false,
  excludeGambling: false,
  excludeReligiousInstitutions: false,
  excludeShisha: false,
  ...overrides,
})

const facts = (overrides: Partial<CategoryPolicyFacts> = {}): CategoryPolicyFacts => ({
  halalStatus: 'unknown',
  alcoholFocus: 'unknown',
  porkEvidence: 'unknown',
  gamblingBusiness: 'unknown',
  religiousInstitution: 'unknown',
  shishaFocused: 'unknown',
  ...overrides,
})

function decisionContext(inputPolicy: CategoryPolicy, inputFacts: CategoryPolicyFacts): LeadDecisionContext {
  return {
    leadId: '00000000-0000-4000-8000-000000000001',
    status: 'email_ready',
    email: 'policy@example.test',
    duplicate: false,
    suppressed: false,
    dealState: 'none',
    initialEmailMode: 'template',
    research: { contactDiscoveryComplete: true, personalisationComplete: false, canSupplyTemplateFields: false },
    template: { available: true, requiredDataAvailable: true },
    initialEmail: { state: 'pending', sentAt: null },
    followUps: {
      followUp1: { state: 'missing', sentAt: null },
      followUp2: { state: 'missing', sentAt: null },
      followUp3: { state: 'missing', sentAt: null },
    },
    reply: { received: false, classification: null },
    reactivation: { enabled: false, sentAt: null },
    schedule: { followUp1Days: 7, followUp2Days: 14, followUp3Days: 21, deadLeadDays: 21, reactivationDelayDays: 60, deadAfterReactivationDays: 14 },
    asOf: '2026-09-24T00:00:00.000Z',
    manualOverride: null,
    categoryPolicy: { categoryId: '00000000-0000-4000-8000-000000000002', policy: inputPolicy, facts: inputFacts },
    operationalFacts: { categoryIdPresent: true, hasUsableCategoryContext: true, manualSource: false, recipientOwnership: 'owned_by_lead', openDuplicateFlag: false },
  }
}

function testPurePolicyRules(): void {
  assert.deepEqual(evaluateCategoryPolicy({ policy: policy(), facts: facts() }), { outcome: 'CONTINUE', reasons: [] })
  assert.equal(evaluateCategoryPolicy({ policy: policy({ requiresHalalConfirmation: true }), facts: facts({ halalStatus: 'confirmed' }) }).outcome, 'CONTINUE')
  assert.equal(evaluateCategoryPolicy({ policy: policy({ requiresHalalConfirmation: true }), facts: facts({ halalStatus: 'not_halal' }) }).outcome, 'STOP')
  assert.equal(evaluateCategoryPolicy({ policy: policy({ requiresHalalConfirmation: true }), facts: facts({ halalStatus: 'unknown' }) }).outcome, 'MANUAL_REVIEW')
  assert.equal(evaluateCategoryPolicy({ policy: policy({ excludeAlcoholFocused: true }), facts: facts({ alcoholFocus: 'focused' }) }).outcome, 'STOP')
  assert.equal(evaluateCategoryPolicy({ policy: policy({ excludeAlcoholFocused: true }), facts: facts({ alcoholFocus: 'serves_alcohol' }) }).outcome, 'CONTINUE')
  assert.equal(evaluateCategoryPolicy({ policy: policy({ excludePork: true }), facts: facts({ porkEvidence: 'confirmed_incompatible' }) }).outcome, 'STOP')
  assert.equal(evaluateCategoryPolicy({ policy: policy({ excludeGambling: true }), facts: facts({ gamblingBusiness: 'confirmed' }) }).outcome, 'STOP')
  assert.equal(evaluateCategoryPolicy({ policy: policy({ excludeReligiousInstitutions: true }), facts: facts({ religiousInstitution: 'confirmed' }) }).outcome, 'STOP')
  assert.equal(evaluateCategoryPolicy({ policy: policy({ excludeShisha: true }), facts: facts({ shishaFocused: 'confirmed' }) }).outcome, 'STOP')

  assert.deepEqual(normalizeCategoryPolicyFacts({ halalStatus: 'invented', alcoholFocus: 42 }), facts(), 'Malformed or absent evidence stays unknown')

  const multiple = evaluateCategoryPolicy({
    policy: policy({ excludePork: true, excludeGambling: true, excludeShisha: true }),
    facts: facts({ porkEvidence: 'confirmed_incompatible', gamblingBusiness: 'confirmed', shishaFocused: 'confirmed' }),
  })
  assert.equal(multiple.outcome, 'STOP')
  assert.deepEqual(multiple.reasons.map((reason) => reason.code), [
    'CATEGORY_POLICY_PORK_INCOMPATIBLE', 'CATEGORY_POLICY_GAMBLING', 'CATEGORY_POLICY_SHISHA_FOCUSED',
  ])
  assert.deepEqual(evaluateCategoryPolicy({ policy: policy({ excludePork: true }), facts: facts({ porkEvidence: 'unknown' }) }).outcome, 'MANUAL_REVIEW')

  const input = { policy: policy({ excludeGambling: true }), facts: facts({ gamblingBusiness: 'confirmed' }) }
  assert.deepEqual(evaluateCategoryPolicy(input), evaluateCategoryPolicy(input), 'Evaluation is deterministic')

  const excluded = decisionContext(policy({ excludeGambling: true }), facts({ gamblingBusiness: 'confirmed' }))
  assert.equal(decideNextAction({ ...excluded, duplicate: true }).reasonCode, 'DUPLICATE_LEAD')
  assert.equal(decideNextAction({ ...excluded, suppressed: true }).reasonCode, 'SUPPRESSED')
  assert.equal(decideNextAction({ ...excluded, operationalFacts: { ...excluded.operationalFacts!, recipientOwnership: 'owned_by_other' } }).reasonCode, 'RECIPIENT_OWNED_BY_OTHER')
}

async function testSendPrevention(): Promise<void> {
  for (const [expectedAction, inputPolicy, inputFacts] of [
    ['STOP', policy({ excludeGambling: true }), facts({ gamblingBusiness: 'confirmed' })],
    ['MANUAL_REVIEW', policy({ requiresHalalConfirmation: true }), facts({ halalStatus: 'unknown' })],
  ] as const) {
    const context = decisionContext(inputPolicy, inputFacts)
    assert.equal(decideNextAction(context).action, expectedAction)
    let senderCalls = 0
    const dependencies: OrchestratorDependencies = {
      client: {} as OrchestratorDependencies['client'],
      telemetry: {
        async startWorkflowRun() { return 'policy-run' }, async completeWorkflowRun() { return true }, async failWorkflowRun() { return true },
        async startWorkflowStep() { return 'policy-step' }, async completeWorkflowStep() { return true }, async failWorkflowStep() { return true },
      },
      executors: { SEND_INITIAL: async () => { senderCalls++; return { outcome: 'completed', changedState: true } } },
      loadContext: async () => context,
      decide: decideNextAction,
      acquireLeadLock: async () => 'policy-lock',
      releaseLeadLock: async () => {},
    }
    const result = await orchestrateLead({ workspaceId: '00000000-0000-4000-8000-000000000003', workflowType: 'lead_lifecycle', leadId: context.leadId, source: 'category-policy.test' }, dependencies)
    assert.equal(result.finalAction, expectedAction)
    assert.equal(senderCalls, 0, `${expectedAction} must not reach Sender`)
  }
}

function testStaticBoundaries(): void {
  const root = resolve(import.meta.dirname, '..')
  const evaluator = readFileSync(resolve(root, 'src/domain/category-policy/evaluate.ts'), 'utf8')
  const orchestrator = readFileSync(resolve(root, 'src/domain/orchestrator/orchestrate-lead.ts'), 'utf8')
  const route = readFileSync(resolve(root, 'src/app/api/categories/route.ts'), 'utf8')
  const modal = readFileSync(resolve(root, 'src/components/settings/CategoryModal.tsx'), 'utf8')
  assert.doesNotMatch(evaluator, /supabase|fetch\(|openai|anthropic|gemini|logger|Date\./i, 'Policy evaluator is pure and deterministic')
  assert.doesNotMatch(orchestrator, /halal|alcohol|pork|gambling|religious|shisha|hookah/i, 'Orchestrator contains no duplicated policy interpretation')
  assert.match(route, /canManageCategories/)
  assert.match(route, /eq\(['"]workspace_id['"], workspace\.workspaceId\)/)
  for (const label of ['Targeting &amp; Exclusions', 'Require verified halal confirmation', 'Alcohol-focused businesses', 'Pork-related businesses', 'Gambling businesses', 'Religious institutions', 'Shisha or hookah businesses', 'Custom policy notes']) {
    assert.ok(modal.includes(label), `Category UI includes ${label}`)
  }
  assert.equal(categoryFieldsSchema.safeParse({ exclude_gambling: 'true' }).success, false, 'Malformed policy booleans are rejected')
  assert.equal(categoryFieldsSchema.safeParse({ custom_policy_instructions: 'x'.repeat(2001) }).success, false, 'Policy notes are bounded')
}

async function testDatabaseDefaultsAndTenancy(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  assert.ok(url && anonKey && serviceKey, 'V2 local Supabase environment is required')
  const parsedUrl = new URL(url)
  assert.ok(parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost', 'Category policy database tests refuse non-local Supabase targets')
  const service = createClient<Database>(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const suffix = randomUUID()
  const password = `Policy-${suffix}!`
  const emails = [`policy-a-${suffix}@example.test`, `policy-b-${suffix}@example.test`]
  const users: string[] = []
  const workspaces: string[] = []
  let categoryId: string | null = null
  let leadId: string | null = null
  try {
    for (const email of emails) {
      const created = await service.auth.admin.createUser({ email, password, email_confirm: true })
      assert.ifError(created.error)
      users.push(created.data.user!.id)
    }
    for (const index of [0, 1]) {
      const created = await service.from('workspaces').insert({ name: `Policy Workspace ${index} ${suffix}`, slug: `policy-${index}-${suffix}` }).select('id').single()
      assert.ifError(created.error)
      workspaces.push(created.data!.id)
      assert.ifError((await service.from('workspace_members').insert({ workspace_id: created.data!.id, user_id: users[index], role: 'owner', status: 'active' })).error)
    }
    const category = await service.from('categories').insert({ workspace_id: workspaces[1], name: `Policy Category ${suffix}` }).select('id,halal_filter,exclude_alcohol_focused,exclude_pork,exclude_gambling,exclude_religious_institutions,exclude_shisha,custom_policy_instructions').single()
    assert.ifError(category.error)
    categoryId = category.data!.id
    assert.deepEqual({
      halal_filter: category.data!.halal_filter,
      exclude_alcohol_focused: category.data!.exclude_alcohol_focused,
      exclude_pork: category.data!.exclude_pork,
      exclude_gambling: category.data!.exclude_gambling,
      exclude_religious_institutions: category.data!.exclude_religious_institutions,
      exclude_shisha: category.data!.exclude_shisha,
      custom_policy_instructions: category.data!.custom_policy_instructions,
    }, {
      halal_filter: false, exclude_alcohol_focused: false, exclude_pork: false, exclude_gambling: false,
      exclude_religious_institutions: false, exclude_shisha: false, custom_policy_instructions: null,
    }, 'Existing behavior is preserved by safe defaults')

    assert.ifError((await service.from('categories').update({ exclude_gambling: true }).eq('id', categoryId)).error)
    const lead = await service.from('leads').insert({
      workspace_id: workspaces[1], business_name: `Policy Lead ${suffix}`, category_id: categoryId,
      category_name: `Policy Category ${suffix}`, city: 'Sydney', status: 'email_ready', email: `lead-${suffix}@example.test`,
      category_policy_facts: { gamblingBusiness: 'confirmed' },
    }).select('id').single()
    assert.ifError(lead.error)
    leadId = lead.data!.id
    const integrated = await loadDecisionContext(service, leadId, { asOf: '2026-09-24T00:00:00.000Z', initialEmailMode: 'template' })
    assert(integrated)
    assert.equal(decideNextAction(integrated).reasonCode, 'CATEGORY_POLICY_GAMBLING', 'Loaded category policy and lead facts reach the Decision Engine')

    const invalidFacts = await service.from('leads').insert({
      workspace_id: workspaces[1], business_name: `Invalid Policy Facts ${suffix}`, category_id: categoryId,
      category_name: `Policy Category ${suffix}`, city: 'Sydney', category_policy_facts: { gamblingBusiness: 'maybe' },
    })
    assert(invalidFacts.error, 'Database rejects malformed structured policy facts')

    const clientA = createClient<Database>(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
    assert.ifError((await clientA.auth.signInWithPassword({ email: emails[0], password })).error)
    const foreignRead = await clientA.from('categories').select('id').eq('id', categoryId)
    assert.ifError(foreignRead.error)
    assert.equal(foreignRead.data?.length, 0, 'Workspace A cannot read Workspace B policy')
    const foreignUpdate = await clientA.from('categories').update({ exclude_gambling: true }).eq('id', categoryId).select('id')
    assert.ifError(foreignUpdate.error)
    assert.equal(foreignUpdate.data?.length, 0, 'Workspace A cannot update Workspace B policy')
    const foreignLead = await clientA.from('leads').insert({
      workspace_id: workspaces[0], business_name: `Foreign Category Lead ${suffix}`, category_id: categoryId,
      category_name: `Policy Category ${suffix}`, city: 'Sydney',
    })
    assert(foreignLead.error, 'Workspace A cannot attach a lead to Workspace B category policy')
  } finally {
    if (leadId) await service.from('leads').delete().eq('id', leadId)
    if (categoryId) await service.from('categories').delete().eq('id', categoryId)
    for (const workspaceId of workspaces) await service.from('workspaces').delete().eq('id', workspaceId)
    for (const userId of users) await service.auth.admin.deleteUser(userId)
  }
}

async function main(): Promise<void> {
  testPurePolicyRules()
  await testSendPrevention()
  testStaticBoundaries()
  const databaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const hostname = databaseUrl ? new URL(databaseUrl).hostname : ''
  if (hostname === '127.0.0.1' || hostname === 'localhost') {
    await testDatabaseDefaultsAndTenancy()
  } else {
    console.log('CATEGORY_POLICY_LOCAL_DATABASE_TEST_SKIPPED: set NEXT_PUBLIC_SUPABASE_URL to isolated local Supabase')
  }
  console.log('REACHAGENT_V2_CATEGORY_POLICY_TEST_PASS')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
