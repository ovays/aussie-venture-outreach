import type { SupabaseClient } from '@supabase/supabase-js'
import { decideNextAction, loadDecisionContext } from '@/domain/decision-engine'
import { createServiceClient } from '@/lib/supabase/server'
import { observability } from '@/lib/observability/service'
import { sendInitialOutreach } from '@/services/outbound'
import type { ServiceExecutionResult } from '@/services/result'
import {
  assertCanaryAllowlistLeadId,
  assertCanarySingleRun,
  V2_CANARY_WORKFLOW_TYPE,
} from './v2-canary-safety'
import {
  hashCanaryContent,
  recipientFingerprint,
  redactEmailPreview,
  V2_CANARY_SENDER_IDENTITY,
} from './v2-canary-approval'
import { classifyEmailQuality, normalizeEmail } from './data-quality'
import type { Database } from '@/types/database'

export interface CanaryPreview {
  ok: boolean
  reason?: string
  leadId: string
  recipient?: string | null
  redactedRecipient?: string
  recipientFingerprint?: string | null
  intentId?: string
  subject?: string
  contentHash?: string
  sender: string
}

/** Read-only exact-lead preview. Computes the immutable content hash without sending. */
export async function previewCanaryLead(
  client: SupabaseClient<Database>,
  leadId: string,
): Promise<CanaryPreview> {
  if (!leadId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leadId)) {
    throw new Error('Preview requires a valid exact lead UUID.')
  }
  const selected = await client.from('emails')
    .select('id,subject,body_html,body_text,status,leads!inner(id,email,status,source,delivery_suppressed_emails)')
    .eq('lead_id', leadId).eq('type', 'initial_pitch').eq('status', 'pending_send')
    .order('created_at', { ascending: true }).limit(1).maybeSingle()

  const base: CanaryPreview = { ok: false, leadId, sender: V2_CANARY_SENDER_IDENTITY }
  if (selected.error) return { ...base, reason: selected.error.message }
  if (!selected.data) return { ...base, reason: 'pending_initial_not_found' }

  const record = selected.data as unknown as {
    id: string
    subject: string
    body_html: string
    body_text: string
    leads: { email: string | null; status: string; source: string | null; delivery_suppressed_emails: string[] | null }
  }
  const lead = record.leads
  const recipient = normalizeEmail(lead.email)
  if (!lead.email || lead.status !== 'email_ready') return { ...base, reason: 'lead_not_sendable' }
  if (lead.source === 'manual') return { ...base, reason: 'manual_source_requires_manual_send' }
  const quality = classifyEmailQuality(lead.email)
  if (quality.issueType) return { ...base, reason: `recipient_quality_${quality.issueType}` }
  if (!recipient) return { ...base, reason: 'recipient_missing' }

  const contentHash = hashCanaryContent({
    recipient,
    sender: V2_CANARY_SENDER_IDENTITY,
    subject: record.subject,
    html: record.body_html,
    text: record.body_text,
    intentId: record.id,
    phase: 'initial_pitch',
  })

  return {
    ok: true,
    leadId,
    recipient,
    redactedRecipient: redactEmailPreview(recipient),
    recipientFingerprint: recipientFingerprint(recipient),
    intentId: record.id,
    subject: record.subject,
    contentHash,
    sender: V2_CANARY_SENDER_IDENTITY,
  }
}

export interface CanaryRunResult {
  status: 'completed' | 'skipped' | 'manual_review' | 'failed'
  reason: string
  action?: string
  execution?: ServiceExecutionResult
  workflowRunId?: string | null
}

export interface RunCanaryInitialSendInput {
  leadId: string
  correlationId?: string
  idempotencyKey?: string
}

/**
 * Dedicated unscheduled exact-lead canary entry. Runs at most one SEND_INITIAL
 * iteration. Selection, generation, follow-ups, reactivation, and broad pipelines
 * are intentionally out of scope.
 */
export async function runCanaryInitialSend(input: RunCanaryInitialSendInput): Promise<CanaryRunResult> {
  assertCanarySingleRun()
  assertCanaryAllowlistLeadId(input.leadId)

  const client = createServiceClient() as SupabaseClient<Database>
  const context = await loadDecisionContext(client, input.leadId)
  if (!context) return { status: 'failed', reason: 'LEAD_NOT_FOUND' }

  const decision = decideNextAction(context)
  if (decision.action !== 'SEND_INITIAL') {
    return { status: 'manual_review', reason: decision.reasonCode, action: decision.action }
  }

  const telemetry = observability()
  const workflowRunId = await telemetry.startWorkflowRun({
    workflowType: V2_CANARY_WORKFLOW_TYPE,
    source: 'manual_canary',
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    leadId: input.leadId,
    decision,
    metadata: { canary: true, max_iterations: 1 },
  })

  const decisionStepId = await telemetry.startWorkflowStep({
    workflowRunId: workflowRunId ?? undefined,
    stepName: 'canary_decision',
    stepType: 'decision',
    leadId: input.leadId,
    sequence: 10,
    decision,
    inputSummary: { inputs_used: decision.inputsUsed },
  })
  await telemetry.completeWorkflowStep(decisionStepId, {
    outputSummary: { action: decision.action, reason_code: decision.reasonCode, ...decision.metadata },
  })

  const executorStepId = await telemetry.startWorkflowStep({
    workflowRunId: workflowRunId ?? undefined,
    stepName: 'canary_initial_send',
    stepType: 'executor',
    leadId: input.leadId,
    sequence: 11,
    inputSummary: { action: decision.action, reason_code: decision.reasonCode, iteration: 1 },
  })

  let execution: ServiceExecutionResult
  try {
    execution = await sendInitialOutreach({
      client,
      leadId: input.leadId,
      decisionReason: decision.reasonCode,
      correlationId: input.correlationId,
    })
  } catch (error) {
    await telemetry.failWorkflowStep(executorStepId, error, { iteration: 1, retryable: true })
    await telemetry.failWorkflowRun(workflowRunId, error, { iteration_count: 1, final_action: 'SEND_INITIAL' })
    throw error
  }

  const details = execution.details ?? {}
  if (execution.outcome === 'failed') {
    await telemetry.failWorkflowStep(executorStepId, new Error(String(details.reason ?? 'executor_failed')), {
      iteration: 1, retryable: execution.retryable ?? false, ...details,
    })
    await telemetry.failWorkflowRun(workflowRunId, new Error(String(details.reason ?? 'executor_failed')), {
      iteration_count: 1, final_action: 'SEND_INITIAL',
    })
    return { status: 'failed', reason: String(details.reason ?? 'executor_failed'), action: 'SEND_INITIAL', execution, workflowRunId }
  }

  await telemetry.completeWorkflowStep(executorStepId, {
    status: execution.outcome === 'waiting' ? 'waiting' : execution.outcome === 'skipped' ? 'skipped' : 'succeeded',
    responseStatus: execution.outcome,
    outputSummary: { changed_state: execution.changedState, ...details },
  })
  await telemetry.completeWorkflowRun(
    workflowRunId,
    execution.outcome === 'waiting' ? 'waiting' : execution.outcome === 'skipped' ? 'skipped' : 'succeeded',
    { iteration_count: 1, final_action: 'SEND_INITIAL', stopped_because: execution.outcome.toUpperCase() },
  )

  return {
    status: execution.outcome === 'completed' ? 'completed' : 'skipped',
    reason: String(details.reason ?? execution.outcome),
    action: 'SEND_INITIAL',
    execution,
    workflowRunId,
  }
}
