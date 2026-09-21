import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import { ObservabilityService } from '../src/lib/observability/service'
import { normalizeObservabilityError } from '../src/lib/observability/errors'
import { MAX_OBSERVABILITY_JSON_BYTES, sanitizeErrorMessage, sanitizeObservabilityMetadata } from '../src/lib/observability/sanitize'
import { withWorkflowTrace } from '../src/lib/observability/context'
import { assertV2SupabaseTarget } from '../src/lib/v2-runtime-safety'

assertV2SupabaseTarget()
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const serviceClient = createClient<Database>(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const telemetry = new ObservabilityService(serviceClient as never)
const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'

const suffix = Date.now().toString(36)
const password = `V2-observe-${suffix}!`
const adminEmail = `v2-observe-admin-${suffix}@example.test`
const memberEmail = `v2-observe-member-${suffix}@example.test`
let adminId: string | undefined
let memberId: string | undefined
let parentRunId: string | null = null
let childRunId: string | null = null
let leadId: string | undefined

async function signedIn(email: string) {
  const client = createClient<Database>(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  assert.ifError((await client.auth.signInWithPassword({ email, password })).error)
  return client
}

async function main() {
  const secretMetadata = sanitizeObservabilityMetadata({
    safe: 'visible', apiKey: 'sk-secret-value', nested: { authorization: 'Bearer abc.def.ghi', count: 2 },
    body_html: '<p>customer content</p>', prompt: 'private prompt', accessToken: 'private', passwordHash: 'private', rawMessageBody: 'private',
  })
  assert.equal(secretMetadata.safe, 'visible')
  assert.equal(secretMetadata.apiKey, '[REDACTED]')
  assert.deepEqual(secretMetadata.nested, { authorization: '[REDACTED]', count: 2 })
  assert.equal(secretMetadata.body_html, '[REDACTED]')
  assert.equal(secretMetadata.prompt, '[REDACTED]')
  assert.equal(secretMetadata.accessToken, '[REDACTED]')
  assert.equal(secretMetadata.passwordHash, '[REDACTED]')
  assert.equal(secretMetadata.rawMessageBody, '[REDACTED]')
  const bounded = sanitizeObservabilityMetadata({ huge: 'x'.repeat(100_000) })
  assert(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= MAX_OBSERVABILITY_JSON_BYTES)
  assert(!sanitizeErrorMessage('failed for person@example.com token-secretvalue').includes('person@example.com'))
  assert.equal(normalizeObservabilityError(Object.assign(new Error('rate limit 429'), { code: 'RATE_429' })).category, 'RATE_LIMIT')
  assert.equal(normalizeObservabilityError(new Error('socket timeout')).retryable, true)

  const failedWrites: string[] = []
  const failing = new ObservabilityService({
    from: () => ({ insert: () => { throw new Error('database offline') } }),
  } as never, true, (message) => failedWrites.push(message))
  assert.equal(await failing.startWorkflowRun({ workspaceId: WORKSPACE_ID, workflowType: 'sender', source: 'test' }), null)
  assert.equal(failedWrites.length, 1, 'best-effort telemetry failures must be reported without breaking sender/core work')

  const leadInsert = await serviceClient.from('leads').insert({
    workspace_id: WORKSPACE_ID,
    business_name: `Observability Synthetic ${suffix}`, category_name: 'Synthetic', city: 'Test City', status: 'new', source: 'manual',
  }).select('id').single()
  assert.ifError(leadInsert.error); leadId = leadInsert.data.id
  assert(leadId)
  const syntheticLeadId = leadId

  const integrationStarted = performance.now()
  parentRunId = await telemetry.startWorkflowRun({
    workspaceId: WORKSPACE_ID,
    workflowType: 'daily_pipeline', source: 'test', triggerTaskId: 'daily-pipeline',
    triggerRunId: `trigger-${suffix}`, correlationId: `correlation-${suffix}`,
    idempotencyKey: `pipeline-${suffix}`, attempt: 2,
    metadata: { api_key: 'must-redact', reason: 'observability integration test' },
  })
  assert(parentRunId)

  const decision = { action: 'SEND_INITIAL', reasonCode: 'INITIAL_CONTENT_READY', leadId: syntheticLeadId, inputsUsed: ['initialEmail.state'] } as const
  childRunId = await telemetry.startWorkflowRun({
    workspaceId: WORKSPACE_ID,
    workflowType: 'initial_outreach_lead', source: 'test', parentRunId,
    correlationId: `email-intent-${suffix}`, attempt: 1, decision,
  })
  assert(childRunId)

  await withWorkflowTrace({ workspaceId: WORKSPACE_ID, workflowRunId: childRunId }, async () => {
    await telemetry.recordDecisionResults([decision], 'send_initial_decision', 10)
    const completedStep = await telemetry.startWorkflowStep({
      stepName: 'resend_send', stepType: 'provider_request', sequence: 20, attempt: 2,
      provider: 'resend', inputSummary: { email_intent_id: `intent-${suffix}`, authorization: 'Bearer no' },
    })
    assert(completedStep)
    assert.equal(await telemetry.completeWorkflowStep(completedStep, {
      provider: 'resend', externalRequestId: `request-${suffix}`, externalMessageId: `message-${suffix}`,
      responseStatus: 'accepted', retryCount: 1, outputSummary: { outcome: 'accepted' },
    }), true)

    const failedStep = await telemetry.startWorkflowStep({ stepName: 'provider_retry', stepType: 'provider_request', sequence: 30, provider: 'hostinger' })
    assert(failedStep)
    assert.equal(await telemetry.failWorkflowStep(
      failedStep,
      Object.assign(new Error('socket timeout for person@example.com'), { code: 'ETIMEDOUT' }),
      { retry_count: 2, outcome: 'uncertain', retryable: true },
    ), true)
    assert(await telemetry.skipWorkflowStep({ stepName: 'writer', stepType: 'agent', sequence: 40 }, 'NOT_REQUIRED'))

    const aiStep = await telemetry.startWorkflowStep({ stepName: 'ai_generate', stepType: 'ai_request', sequence: 50, provider: 'openai', model: 'synthetic-model' })
    assert(aiStep)
    assert.ifError((await serviceClient.from('ai_request_logs').insert({
      workspace_id: WORKSPACE_ID,
      workflow_run_id: childRunId, workflow_step_id: aiStep, provider_request_id: `ai-request-${suffix}`,
      created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      workflow: 'initial_email', provider: 'openai', model: 'synthetic-model', status: 'succeeded', duration_ms: 1,
      input_tokens: 10, output_tokens: 5, total_tokens: 15, estimated_cost_usd: 0.00001,
      retry_count: 0, request_source: 'test', metadata: {},
    })).error)
    await telemetry.completeWorkflowStep(aiStep, { provider: 'openai', model: 'synthetic-model' })
    await telemetry.observeLeadStatusTransition({
      leadId: syntheticLeadId, fromStatus: 'new', toStatus: 'researched', actor: 'test', reasonCode: 'PERSONALIZED_RESEARCH_REQUIRED',
    })
  })

  assert.equal(await telemetry.failWorkflowRun(childRunId, new Error('provider failed safely')), true)
  assert.equal(await telemetry.completeWorkflowRun(parentRunId, 'partial', { failed_child: childRunId }), true)

  const { data: run, error: runError } = await serviceClient.from('workflow_runs').select('*').eq('id', parentRunId).single()
  assert.ifError(runError)
  assert.equal(run.status, 'partial')
  assert.equal(run.attempt, 2)
  assert.equal(run.trigger_run_id, `trigger-${suffix}`)
  assert(run.duration_ms !== null && run.duration_ms >= 0)
  assert.equal((run.metadata as Record<string, unknown>).failed_child, childRunId)

  const { data: child, error: childError } = await serviceClient.from('workflow_runs').select('*').eq('id', childRunId).single()
  assert.ifError(childError)
  assert.equal(child.parent_run_id, parentRunId)
  assert.equal(child.decision_action, 'SEND_INITIAL')
  assert.equal(child.decision_reason_code, 'INITIAL_CONTENT_READY')

  const { data: steps, error: stepsError } = await serviceClient.from('workflow_steps').select('*').eq('workflow_run_id', childRunId)
  assert.ifError(stepsError)
  assert(steps.some((step) => step.status === 'succeeded' && step.external_request_id === `request-${suffix}` && step.retry_count === 1))
  assert(steps.some((step) => step.status === 'failed' && step.error_category === 'TIMEOUT' && step.retryable === true && step.retry_count === 2 && step.response_status === 'uncertain'))
  assert(steps.some((step) => step.status === 'skipped'))
  assert(steps.some((step) => step.decision_action === 'SEND_INITIAL' && step.decision_reason_code === 'INITIAL_CONTENT_READY'))
  assert(steps.every((step) => step.duration_ms === null || step.duration_ms >= 0))
  assert.equal((steps.find((step) => step.external_request_id === `request-${suffix}`)?.input_summary as Record<string, unknown>).authorization, '[REDACTED]')

  const { data: aiLog, error: aiError } = await serviceClient.from('ai_request_logs').select('workflow_run_id,workflow_step_id,input_tokens,estimated_cost_usd,provider_request_id').eq('provider_request_id', `ai-request-${suffix}`).single()
  assert.ifError(aiError)
  assert.equal(aiLog.workflow_run_id, childRunId)
  assert.equal(aiLog.input_tokens, 10)
  assert.equal(aiLog.provider_request_id, `ai-request-${suffix}`)

  const transition = await serviceClient.from('activity_log').select('metadata').eq('event_type', 'lead_status_transition').eq('lead_id', leadId).order('created_at', { ascending: false }).limit(1).single()
  assert.ifError(transition.error)
  assert.deepEqual(transition.data.metadata, {
    actor: 'test', from_status: 'new', to_status: 'researched', reason_code: 'PERSONALIZED_RESEARCH_REQUIRED',
    workflow_run_id: childRunId, workflow_step_id: null,
  })

  const adminCreated = await serviceClient.auth.admin.createUser({ email: adminEmail, password, email_confirm: true })
  assert.ifError(adminCreated.error); adminId = adminCreated.data.user?.id; assert(adminId)
  const memberCreated = await serviceClient.auth.admin.createUser({ email: memberEmail, password, email_confirm: true })
  assert.ifError(memberCreated.error); memberId = memberCreated.data.user?.id; assert(memberId)
  assert.ifError((await serviceClient.from('profiles').update({ role: 'admin' }).eq('id', adminId)).error)
  const admin = await signedIn(adminEmail)
  const member = await signedIn(memberEmail)
  const anon = createClient<Database>(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })

  const adminRead = await admin.from('workflow_runs').select('id').eq('id', parentRunId)
  assert.ifError(adminRead.error); assert.equal(adminRead.data.length, 1)
  const memberRead = await member.from('workflow_runs').select('id').eq('id', parentRunId)
  assert.ifError(memberRead.error); assert.equal(memberRead.data.length, 0, 'member RLS must hide raw observability rows')
  assert((await member.from('workflow_runs').insert({ workspace_id: WORKSPACE_ID, workflow_type: 'denied', source: 'test' })).error, 'member mutation must be denied')
  assert((await anon.from('workflow_runs').select('id')).error, 'anon read must be denied by table privileges')
  const detail = await admin.rpc('admin_workflow_run_detail', { p_run_id: childRunId })
  assert.ifError(detail.error); assert(detail.data)
  const memberDetail = await member.rpc('admin_workflow_run_detail', { p_run_id: childRunId })
  assert.equal(memberDetail.data, null, 'member diagnostic RPC must expose no run')

  const integrationWallClockMs = Math.round((performance.now() - integrationStarted) * 10) / 10
  console.log(JSON.stringify({ result: 'V2_OBSERVABILITY_PASS', parentRunId, childRunId, integrationWallClockMs, note: 'local multi-write integration path; not an SLA' }))
}

main().finally(async () => {
  if (parentRunId) await serviceClient.from('workflow_runs').delete().eq('id', parentRunId)
  if (leadId) await serviceClient.from('leads').delete().eq('id', leadId)
  if (adminId) await serviceClient.auth.admin.deleteUser(adminId)
  if (memberId) await serviceClient.auth.admin.deleteUser(memberId)
}).catch((error) => { console.error(error); process.exitCode = 1 })
