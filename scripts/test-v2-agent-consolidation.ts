import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { researchPurposeForMode } from '@/services/research'
import { readOrchestratorFlags } from '@/domain/orchestrator/flags'
import { EXECUTABLE_ACTIONS } from '@/domain/orchestrator/executor-map'
import { outboundIdempotencyKey, outboundMessageId } from '@/lib/outbound-send'

const root = process.cwd()
const source = (path: string) => readFileSync(join(root, path), 'utf8')

function imports(text: string): string[] {
  return [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
}

function check(name: string, test: () => void) {
  test()
  console.log(`PASS ${name}`)
}

const executors = source('src/domain/orchestrator/executors.ts')
const orchestratorFiles = [
  'batch.ts', 'executor-map.ts', 'executors.ts', 'flags.ts', 'index.ts',
  'orchestrate-lead.ts', 'runtime.ts', 'state-fingerprint.ts', 'types.ts',
].map((file) => source(`src/domain/orchestrator/${file}`)).join('\n')
const templateEngine = source('src/services/initial-content/template-renderer.ts')
const initialContent = source('src/services/initial-content/generate-initial-content.ts')
const initialRouter = source('src/lib/initial-email-router.ts')
const research = source('src/services/research/research-lead.ts')
const followUp = source('src/services/followup/send-follow-up.ts')
const reactivation = source('src/services/reactivation/send-reactivation.ts')
const outbound = source('src/services/outbound/send-initial-outreach.ts')
const finder = source('agents/finder.ts')
const tracker = source('agents/tracker.ts')

check('Orchestrator imports canonical services, not batch agents', () => {
  assert.deepEqual(imports(orchestratorFiles).filter((item) => item.includes('agents/')), [])
  for (const boundary of ['@/services/research', '@/services/initial-content', '@/services/outbound', '@/services/followup', '@/services/reactivation']) {
    assert.ok(imports(executors).includes(boundary), `missing ${boundary}`)
  }
})

check('Decision Engine remains the only router and no AI router exists', () => {
  assert.ok(orchestratorFiles.includes("from '@/domain/decision-engine'"))
  assert.doesNotMatch(orchestratorFiles, /@\/ai\/|AnthropicProvider|OpenAIProvider|GeminiProvider|aiRegistry/)
  assert.doesNotMatch(executors, /if\s*\(.*status\s*===\s*['"](?:new|researched|contacted)/)
})

check('Template Engine is deterministic and separated from Writer AI', () => {
  assert.doesNotMatch(templateEngine, /@\/ai\/|AIProvider|aiRegistry|anthropic|openai|gemini/i)
  assert.match(initialRouter, /if \(mode === 'template'\)[\s\S]*renderInitialTemplate/)
  assert.ok(initialRouter.indexOf('const result = await renderInitialTemplate') < initialRouter.indexOf("const writer = aiWriter ?? (await import('@/ai/writer')).writePersonalizedInitialContent"))
  assert.doesNotMatch(initialContent, /@\/ai\/providers|aiRegistry/)
})

check('Template and personalized purpose mapping prevents personalization AI in template mode', () => {
  assert.equal(researchPurposeForMode('template'), 'CONTACT_DISCOVERY')
  assert.equal(researchPurposeForMode('ai_personalised'), 'PERSONALIZATION')
  assert.match(research, /purpose === 'CONTACT_DISCOVERY' \? 'contact_discovery_only' : 'full_personalisation'/)
  assert.match(source('src/lib/research-lead.ts'), /websiteText && purpose === 'full_personalisation'/)
})

check('Exact-lead services neither select batches nor choose workflow stages', () => {
  for (const [name, text] of Object.entries({ research, initialContent, followUp, reactivation, outbound })) {
    assert.match(text, /\.eq\('id'|\.eq\('lead_id'/, `${name} is not exact-lead scoped`)
    assert.doesNotMatch(text, /\.range\(|Promise\.all\(|decideNextAction|decideContactedOutreach/, `${name} contains selection/routing`)
  }
  assert.match(followUp, /type: FollowUpType/)
  for (const stage of ['follow_up_1', 'follow_up_2', 'follow_up_3']) assert.match(executors, new RegExp(stage))
})

check('Decision regressions cover template, personalized, existing-content, and all follow-up paths', () => {
  const decisions = source('scripts/test-v2-decision-engine.ts')
  for (const scenario of [
    'new template lead with sufficient data', 'template new lead missing email',
    'new personalized lead', 'researched personalized lead',
    'duplicate pending content is sent not regenerated',
    'contacted after FU1 due', 'FU1 sent and FU2 due', 'FU2 sent and FU3 due',
  ]) assert.ok(decisions.includes(scenario), `missing decision case: ${scenario}`)
})

check('Follow-up and Reactivation retain durable provider identity protections', () => {
  for (const text of [source('agents/followup.ts'), reactivation, outbound]) {
    assert.match(text, /outboundIdempotencyKey/)
    assert.match(text, /outboundMessageId/)
  }
  assert.equal(outboundIdempotencyKey('email-1'), 'reachagent-email-email-1')
  assert.equal(outboundMessageId('email-1'), '<email-1@aussieventure.com>')
})

check('Finder stays outside the per-lead Orchestrator', () => {
  assert.ok(!EXECUTABLE_ACTIONS.includes('FINDER' as never))
  assert.match(finder, /findExistingCandidates/)
  assert.match(finder, /createLeadDedupeIndex/)
  assert.doesNotMatch(orchestratorFiles, /runFinderAgent|FinderService/)
})

check('Tracker remains deterministic and Reply Agent is deferred', () => {
  assert.match(tracker, /isAutomatedInboundEmail/)
  assert.match(tracker, /processInboundReply/)
  assert.doesNotMatch(tracker, /aiRegistry|@\/ai\/|classifyReply/)
  assert.equal(existsSync(join(root, 'agents/reply.ts')), false)
  assert.equal(existsSync(join(root, 'src/ai/reply')), false)
})

check('Legacy bounded wrappers and deprecated Enricher remain available', () => {
  for (const path of ['agents/finder.ts', 'agents/researcher.ts', 'agents/writer.ts', 'agents/sender.ts', 'agents/followup.ts', 'agents/reactivation.ts', 'agents/tracker.ts', 'agents/enricher.ts']) {
    assert.ok(existsSync(join(root, path)), `${path} was removed`)
  }
  assert.match(source('agents/researcher.ts'), /RESEARCHER_BATCH_SIZE/)
  assert.match(source('agents/writer.ts'), /WRITER_BATCH_SIZE/)
  assert.match(source('agents/reactivation.ts'), /REACTIVATION_BATCH_SIZE/)
})

check('Production-safe flags remain false by default', () => {
  assert.deepEqual(readOrchestratorFlags({} as NodeJS.ProcessEnv), { enabled: false, shadow: false })
  const env = source('.env.v2.example')
  for (const flag of ['ORCHESTRATOR_ENABLED', 'ORCHESTRATOR_SHADOW', 'OUTREACH_SEND_ENABLED', 'TRIGGER_JOBS_ENABLED', 'FINDER_SCHEDULE_ENABLED', 'HOSTINGER_MUTATIONS_ENABLED']) {
    assert.match(env, new RegExp(`^${flag}=false$`, 'm'))
  }
})

console.log('ReachAgent V2 agent consolidation checks passed.')
