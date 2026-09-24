import { STOP_ACTIONS } from './executor-map'
import { decisionStateFingerprint } from './state-fingerprint'
import type {
  ExecutorResult, OrchestrationRequest, OrchestrationResult, OrchestrationStatus,
  OrchestrationStopCause, OrchestratorDependencies,
} from './types'

export const DEFAULT_MAX_ORCHESTRATION_ITERATIONS = 6
export const MAX_ORCHESTRATION_ITERATIONS = 10

function iterationLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) return DEFAULT_MAX_ORCHESTRATION_ITERATIONS
  return Math.min(value!, MAX_ORCHESTRATION_ITERATIONS)
}

function statusFor(cause: OrchestrationStopCause): OrchestrationStatus {
  if (cause === 'WAIT') return 'waiting'
  if (cause === 'MANUAL_REVIEW' || cause === 'HANDOFF_REPLY') return 'manual_review'
  if (cause === 'EXECUTOR_FAILED' || cause === 'UNSUPPORTED_ACTION' || cause === 'LEAD_NOT_FOUND') return 'failed'
  if (cause === 'SHADOW') return 'shadowed'
  if (cause === 'CONCURRENT_EXECUTION' || cause === 'MAX_ITERATIONS' || cause === 'NO_STATE_CHANGE' || cause === 'LOOP_GUARD') return 'skipped'
  return 'succeeded'
}

function completionStatus(status: OrchestrationStatus): 'succeeded' | 'skipped' | 'waiting' {
  if (status === 'waiting' || status === 'manual_review') return 'waiting'
  if (status === 'skipped' || status === 'shadowed') return 'skipped'
  return 'succeeded'
}

export async function orchestrateLead(
  request: OrchestrationRequest,
  dependencies: OrchestratorDependencies,
): Promise<OrchestrationResult> {
  const startedAt = dependencies.now?.() ?? Date.now()
  const workflowRunId = await dependencies.telemetry.startWorkflowRun({
    workspaceId: request.workspaceId,
    workflowType: request.workflowType,
    source: request.source,
    triggerRunId: request.triggerRunId,
    correlationId: request.correlationId,
    parentRunId: request.parentRunId,
    leadId: request.leadId,
    attempt: request.attempt ?? 1,
    metadata: { shadow: request.shadow === true, max_iterations: iterationLimit(request.maxIterations) },
  })
  const actionsExecuted: OrchestrationResult['actionsExecuted'] = []
  let finalAction: OrchestrationResult['finalAction'] = null
  let finalReasonCode: OrchestrationResult['finalReasonCode'] = null
  let iterationCount = 0
  let retryable = false

  const finish = async (stoppedBecause: OrchestrationStopCause): Promise<OrchestrationResult> => {
    const status = statusFor(stoppedBecause)
    const metadata = {
      stopped_because: stoppedBecause,
      final_action: finalAction,
      final_reason_code: finalReasonCode,
      iteration_count: iterationCount,
      actions_executed: actionsExecuted.length,
      duration_ms: (dependencies.now?.() ?? Date.now()) - startedAt,
      retryable,
    }
    if (status === 'failed') {
      await dependencies.telemetry.failWorkflowRun(workflowRunId, new Error(stoppedBecause), metadata)
    } else {
      await dependencies.telemetry.completeWorkflowRun(workflowRunId, completionStatus(status), metadata)
    }
    return { leadId: request.leadId, workflowRunId, status, finalAction, finalReasonCode, actionsExecuted, iterationCount, stoppedBecause, retryable }
  }

  const lockToken = await dependencies.acquireLeadLock(request.leadId)
  if (!lockToken) return finish('CONCURRENT_EXECUTION')

  const seen = new Set<string>()
  try {
    const limit = iterationLimit(request.maxIterations)
    for (let iteration = 1; iteration <= limit; iteration++) {
      iterationCount = iteration
      const context = await dependencies.loadContext(request.leadId)
      if (!context) return finish('LEAD_NOT_FOUND')

      const decision = dependencies.decide(context)
      const legacyComparison = request.shadow ? dependencies.compareLegacy?.(context) : undefined
      finalAction = decision.action
      finalReasonCode = decision.reasonCode
      const decisionStepId = await dependencies.telemetry.startWorkflowStep({
        workspaceId: request.workspaceId,
        workflowRunId,
        stepName: `orchestrator_decision_${iteration}`,
        stepType: 'decision',
        leadId: request.leadId,
        sequence: iteration * 10,
        attempt: request.attempt ?? 1,
        decision,
        inputSummary: {
          inputs_used: decision.inputsUsed,
          category_id: context.categoryPolicy?.categoryId ?? null,
        },
      })
      await dependencies.telemetry.completeWorkflowStep(decisionStepId, {
        outputSummary: {
          action: decision.action, reason_code: decision.reasonCode, ...decision.metadata,
          policy_reasons: decision.reasons ?? [],
          ...(legacyComparison ? {
            legacy_action: legacyComparison.legacyAction,
            legacy_classification: legacyComparison.classification,
            legacy_note: legacyComparison.note,
          } : {}),
        },
      })

      const terminal = STOP_ACTIONS[decision.action]
      if (terminal) {
        if (terminal === 'STOP' && (decision.reasonCode === 'TERMINAL_STATUS' || decision.reasonCode === 'ACTIVE_DEAL_STATUS')) {
          return finish('TERMINAL_STATE')
        }
        return finish(terminal)
      }

      if (request.shadow) return finish('SHADOW')

      const key = `${decision.action}:${decision.reasonCode}:${decisionStateFingerprint(context)}`
      if (seen.has(key)) return finish('LOOP_GUARD')
      seen.add(key)

      const executor = dependencies.executors[decision.action]
      if (!executor) return finish('UNSUPPORTED_ACTION')

      const stepId = await dependencies.telemetry.startWorkflowStep({
        workspaceId: request.workspaceId,
        workflowRunId,
        stepName: `orchestrator_${decision.action.toLowerCase()}`,
        stepType: 'executor',
        leadId: request.leadId,
        sequence: iteration * 10 + 1,
        attempt: request.attempt ?? 1,
        inputSummary: { action: decision.action, reason_code: decision.reasonCode, iteration },
      })
      let execution: ExecutorResult
      try {
        execution = await executor({ client: dependencies.client, context, decision, request, iteration })
      } catch (error) {
        await dependencies.telemetry.failWorkflowStep(stepId, error, { iteration })
        retryable = true
        return finish('EXECUTOR_FAILED')
      }
      actionsExecuted.push({
        action: decision.action, reasonCode: decision.reasonCode, outcome: execution.outcome,
        changedState: execution.changedState, iteration,
      })
      retryable = execution.retryable ?? false
      if (execution.outcome === 'failed') {
        await dependencies.telemetry.failWorkflowStep(stepId, new Error('Executor reported failure'), {
          iteration, retryable, ...execution.details,
        })
        return finish('EXECUTOR_FAILED')
      }
      await dependencies.telemetry.completeWorkflowStep(stepId, {
        status: execution.outcome === 'waiting' ? 'waiting' : execution.outcome === 'skipped' ? 'skipped' : 'succeeded',
        responseStatus: execution.outcome,
        outputSummary: { changed_state: execution.changedState, retryable, ...execution.details },
      })
      if (execution.outcome === 'waiting') return finish('WAIT')
      if (!execution.changedState) return finish('NO_STATE_CHANGE')
    }
    return finish('MAX_ITERATIONS')
  } finally {
    await dependencies.releaseLeadLock(request.leadId, lockToken)
  }
}
