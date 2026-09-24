import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { createWorkspaceServiceClient } from '@/lib/supabase/workspace-service'
import { logger } from '@/lib/logger'
import type { LeadDecisionResult } from '@/domain/decision-engine'
import { currentWorkflowTrace, withWorkflowTrace } from './context'
import { normalizeObservabilityError } from './errors'
import { sanitizeObservabilityMetadata } from './sanitize'

// Server-only by construction: this module depends on the service-role client,
// next/headers through that client, and Node AsyncLocalStorage. Do not export it
// from a client-component boundary.

export type WorkflowStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'partial' | 'skipped' | 'waiting' | 'cancelled'

export interface StartWorkflowRunInput {
  workflowType: string
  source: string
  workspaceId: string
  triggerTaskId?: string
  triggerRunId?: string
  correlationId?: string
  idempotencyKey?: string
  leadId?: string
  categoryId?: string
  parentRunId?: string
  attempt?: number
  decision?: LeadDecisionResult
  metadata?: Record<string, unknown>
}

export interface StartWorkflowStepInput {
  workflowRunId?: string
  workspaceId?: string
  stepName: string
  stepType?: string
  leadId?: string
  sequence?: number
  attempt?: number
  provider?: string
  model?: string
  inputSummary?: Record<string, unknown>
  metadata?: Record<string, unknown>
  decision?: LeadDecisionResult
}

export interface CompleteWorkflowStepInput {
  status?: Exclude<WorkflowStatus, 'queued' | 'running' | 'failed'>
  outputSummary?: Record<string, unknown>
  provider?: string
  model?: string
  externalRequestId?: string
  externalMessageId?: string
  responseStatus?: string
  retryCount?: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  estimatedCostUsd?: number
  metadata?: Record<string, unknown>
}

type Reporter = (message: string, metadata?: Record<string, unknown>) => void
type LeadStatusTransition = {
  leadId: string
  fromStatus: string
  toStatus: string
  actor: string
  reasonCode: string
  eventType?: string
  description?: string
  metadata?: Record<string, unknown>
}

export class ObservabilityService {
  constructor(
    private readonly client: SupabaseClient,
    private readonly bestEffort = true,
    private readonly report: Reporter = (message, metadata) => logger.error('observability', message, metadata),
    private readonly writeTimeoutMs = 1_500,
  ) {}

  private async write<T>(operation: string, work: () => Promise<{ data: T; error: unknown }>): Promise<T | null> {
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Observability write timed out after ${this.writeTimeoutMs}ms`)), this.writeTimeoutMs)
      })
      const result = await Promise.race([work(), timeoutPromise]).finally(() => { if (timeout) clearTimeout(timeout) })
      if (result.error) throw result.error
      return result.data
    } catch (error) {
      const normalized = normalizeObservabilityError(error)
      this.report('Observability persistence failed; core execution is unchanged', {
        operation, category: normalized.category, code: normalized.code, error: normalized.message,
      })
      if (!this.bestEffort) throw error
      return null
    }
  }

  async startWorkflowRun(input: StartWorkflowRunInput): Promise<string | null> {
    const startedAt = new Date().toISOString()
    const row = await this.write<{ id: string }>('start_workflow_run', async () => {
      const result = await this.client.from('workflow_runs').insert({
        workflow_type: input.workflowType,
        status: 'running',
        source: input.source,
        workspace_id: input.workspaceId,
        trigger_task_id: input.triggerTaskId ?? null,
        trigger_run_id: input.triggerRunId ?? null,
        correlation_id: input.correlationId ?? input.triggerRunId ?? null,
        idempotency_key: input.idempotencyKey ?? null,
        lead_id: input.leadId ?? null,
        category_id: input.categoryId ?? null,
        parent_run_id: input.parentRunId ?? null,
        attempt: input.attempt ?? 1,
        decision_action: input.decision?.action ?? null,
        decision_reason_code: input.decision?.reasonCode ?? null,
        started_at: startedAt,
        metadata: sanitizeObservabilityMetadata(input.metadata),
      }).select('id').single()
      return { data: result.data as { id: string }, error: result.error }
    })
    return row?.id ?? null
  }

  async completeWorkflowRun(id: string | null, status: 'succeeded' | 'partial' | 'skipped' | 'waiting' | 'cancelled' = 'succeeded', metadata?: Record<string, unknown>): Promise<boolean> {
    if (!id) return false
    return !!await this.write('complete_workflow_run', async () => {
      const result = await this.client.from('workflow_runs').update({
        status, completed_at: new Date().toISOString(), metadata: sanitizeObservabilityMetadata(metadata),
      }).eq('id', id).select('id').maybeSingle()
      return { data: result.data as { id: string }, error: result.error }
    })
  }

  async failWorkflowRun(id: string | null, error: unknown, metadata?: Record<string, unknown>): Promise<boolean> {
    if (!id) return false
    const normalized = normalizeObservabilityError(error)
    return !!await this.write('fail_workflow_run', async () => {
      const result = await this.client.from('workflow_runs').update({
        status: 'failed', completed_at: new Date().toISOString(), error_category: normalized.category,
        error_code: normalized.code, error_message: normalized.message, metadata: sanitizeObservabilityMetadata(metadata),
      }).eq('id', id).select('id').maybeSingle()
      return { data: result.data as { id: string }, error: result.error }
    })
  }

  async startWorkflowStep(input: StartWorkflowStepInput): Promise<string | null> {
    const trace = currentWorkflowTrace()
    const workflowRunId = input.workflowRunId ?? trace?.workflowRunId
    if (!workflowRunId) return null
    const row = await this.write<{ id: string }>('start_workflow_step', async () => {
      const result = await this.client.from('workflow_steps').insert({
        workflow_run_id: workflowRunId, lead_id: input.leadId ?? null,
        workspace_id: input.workspaceId ?? trace?.workspaceId,
        step_name: input.stepName, step_type: input.stepType ?? input.stepName, status: 'running',
        sequence: input.sequence ?? 0, attempt: input.attempt ?? 1, started_at: new Date().toISOString(),
        provider: input.provider ?? null, model: input.model ?? null,
        decision_action: input.decision?.action ?? null,
        decision_reason_code: input.decision?.reasonCode ?? null,
        input_summary: sanitizeObservabilityMetadata(input.inputSummary),
        metadata: sanitizeObservabilityMetadata(input.metadata),
      }).select('id').single()
      return { data: result.data as { id: string }, error: result.error }
    })
    return row?.id ?? null
  }

  async completeWorkflowStep(id: string | null, input: CompleteWorkflowStepInput = {}): Promise<boolean> {
    if (!id) return false
    return !!await this.write('complete_workflow_step', async () => {
      const result = await this.client.from('workflow_steps').update({
        status: input.status ?? 'succeeded', completed_at: new Date().toISOString(),
        output_summary: sanitizeObservabilityMetadata(input.outputSummary),
        provider: input.provider, model: input.model,
        external_request_id: input.externalRequestId, external_message_id: input.externalMessageId,
        response_status: input.responseStatus, retry_count: input.retryCount ?? 0,
        input_tokens: input.inputTokens, output_tokens: input.outputTokens, total_tokens: input.totalTokens,
        estimated_cost_usd: input.estimatedCostUsd,
        metadata: sanitizeObservabilityMetadata(input.metadata),
      }).eq('id', id).select('id').maybeSingle()
      return { data: result.data as { id: string }, error: result.error }
    })
  }

  async failWorkflowStep(id: string | null, error: unknown, metadata?: Record<string, unknown>): Promise<boolean> {
    if (!id) return false
    const normalized = normalizeObservabilityError(error)
    const retryCount = typeof metadata?.retry_count === 'number' ? Math.max(0, Math.floor(metadata.retry_count)) : 0
    const responseStatus = typeof metadata?.outcome === 'string' ? metadata.outcome.slice(0, 120) : 'failed'
    const retryable = typeof metadata?.retryable === 'boolean' ? metadata.retryable : normalized.retryable
    return !!await this.write('fail_workflow_step', async () => {
      const result = await this.client.from('workflow_steps').update({
        status: 'failed', completed_at: new Date().toISOString(), retryable,
        error_category: normalized.category, error_code: normalized.code, error_message: normalized.message,
        retry_count: retryCount, response_status: responseStatus,
        metadata: sanitizeObservabilityMetadata(metadata),
      }).eq('id', id).select('id').maybeSingle()
      return { data: result.data as { id: string }, error: result.error }
    })
  }

  async skipWorkflowStep(input: StartWorkflowStepInput, reasonCode: string, metadata?: Record<string, unknown>): Promise<string | null> {
    const id = await this.startWorkflowStep(input)
    await this.completeWorkflowStep(id, { status: 'skipped', responseStatus: reasonCode, metadata })
    return id
  }

  async recordDecisionResults(decisions: readonly LeadDecisionResult[], stepName: string, sequence = 0): Promise<void> {
    const runId = currentWorkflowTrace()?.workflowRunId
    if (!runId || decisions.length === 0) return
    const now = new Date().toISOString()
    for (let offset = 0; offset < decisions.length; offset += 250) {
      const batch = decisions.slice(offset, offset + 250)
      await this.write('record_decision_results', async () => {
        const result = await this.client.from('workflow_steps').insert(batch.map((decision) => ({
          workflow_run_id: runId, workspace_id: currentWorkflowTrace()?.workspaceId, lead_id: decision.leadId, step_name: stepName, step_type: 'decision',
          status: 'succeeded', sequence, attempt: 1, started_at: now, completed_at: now,
          decision_action: decision.action, decision_reason_code: decision.reasonCode,
          input_summary: sanitizeObservabilityMetadata({ inputs_used: decision.inputsUsed }),
          output_summary: sanitizeObservabilityMetadata({
            action: decision.action,
            reason_code: decision.reasonCode,
            policy_reasons: decision.reasons ?? [],
            ...decision.metadata,
          }),
        })))
        return { data: true, error: result.error }
      })
    }
  }

  async observeLeadStatusTransition(input: LeadStatusTransition): Promise<void> {
    await this.observeLeadStatusTransitions([input])
  }

  async observeLeadStatusTransitions(inputs: readonly LeadStatusTransition[]): Promise<void> {
    const trace = currentWorkflowTrace()
    for (let offset = 0; offset < inputs.length; offset += 250) {
      const batch = inputs.slice(offset, offset + 250)
      await this.write('observe_lead_status_transition', async () => {
        const result = await this.client.from('activity_log').insert(batch.map((input) => ({
          workspace_id: trace?.workspaceId, event_type: input.eventType ?? 'lead_status_transition', lead_id: input.leadId,
          description: input.description ?? `Lead status changed from ${input.fromStatus} to ${input.toStatus}`,
          metadata: sanitizeObservabilityMetadata({
            ...input.metadata,
            from_status: input.fromStatus, to_status: input.toStatus, actor: input.actor,
            reason_code: input.reasonCode, workflow_run_id: trace?.workflowRunId ?? null,
            workflow_step_id: trace?.workflowStepId ?? null,
          }),
        })))
        return { data: true, error: result.error }
      })
    }
  }
}

const workspaceServices = new Map<string, ObservabilityService>()
let unscopedService: ObservabilityService | undefined
export function observability(workspaceId = currentWorkflowTrace()?.workspaceId): ObservabilityService {
  if (!workspaceId) {
    unscopedService ??= new ObservabilityService(createServiceClient())
    return unscopedService
  }
  let service = workspaceServices.get(workspaceId)
  if (!service) {
    service = new ObservabilityService(createWorkspaceServiceClient(workspaceId))
    workspaceServices.set(workspaceId, service)
  }
  return service
}

export async function withObservedWorkflow<T>(input: StartWorkflowRunInput, work: () => Promise<T>): Promise<T> {
  const service = observability()
  const runId = await service.startWorkflowRun(input)
  try {
    const result = runId ? await withWorkflowTrace({ workspaceId: input.workspaceId, workflowRunId: runId }, work) : await work()
    await service.completeWorkflowRun(runId)
    return result
  } catch (error) {
    await service.failWorkflowRun(runId, error)
    throw error
  }
}

export async function withObservedStep<T>(input: StartWorkflowStepInput, work: () => Promise<T>, summarize?: (result: T) => Record<string, unknown>): Promise<T> {
  const service = observability()
  const stepId = await service.startWorkflowStep(input)
  const parent = currentWorkflowTrace()
  try {
    const result = parent && stepId ? await withWorkflowTrace({ ...parent, workflowStepId: stepId }, work) : await work()
    await service.completeWorkflowStep(stepId, { outputSummary: summarize?.(result) })
    return result
  } catch (error) {
    await service.failWorkflowStep(stepId, error)
    throw error
  }
}
