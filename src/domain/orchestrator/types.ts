import type { SupabaseClient } from '@supabase/supabase-js'
import type { DecisionAction, LeadDecisionContext, LeadDecisionResult } from '@/domain/decision-engine'
import type { Database } from '@/types/database'

export const ORCHESTRATION_WORKFLOW_TYPES = ['lead_lifecycle'] as const
export type OrchestrationWorkflowType = (typeof ORCHESTRATION_WORKFLOW_TYPES)[number]

export interface OrchestrationRequest {
  workflowType: OrchestrationWorkflowType
  leadId: string
  source: string
  triggerRunId?: string
  parentRunId?: string
  correlationId?: string
  maxIterations?: number
  attempt?: number
  shadow?: boolean
}

export const ORCHESTRATION_STOP_CAUSES = [
  'WAIT', 'STOP', 'MANUAL_REVIEW', 'HANDOFF_REPLY', 'TERMINAL_STATE',
  'MAX_ITERATIONS', 'EXECUTOR_FAILED', 'NO_STATE_CHANGE', 'LOOP_GUARD',
  'UNSUPPORTED_ACTION', 'CONCURRENT_EXECUTION', 'LEAD_NOT_FOUND', 'SHADOW',
] as const
export type OrchestrationStopCause = (typeof ORCHESTRATION_STOP_CAUSES)[number]

export type OrchestrationStatus = 'succeeded' | 'waiting' | 'manual_review' | 'failed' | 'skipped' | 'shadowed'

export type ExecutorOutcome = 'completed' | 'skipped' | 'failed' | 'waiting'
export interface ExecutorResult {
  outcome: ExecutorOutcome
  changedState: boolean
  retryable?: boolean
  details?: Readonly<Record<string, string | number | boolean | null>>
}

export interface ExecutedAction {
  action: DecisionAction
  reasonCode: LeadDecisionResult['reasonCode']
  outcome: ExecutorOutcome
  changedState: boolean
  iteration: number
}

export interface OrchestrationResult {
  leadId: string
  workflowRunId: string | null
  status: OrchestrationStatus
  finalAction: DecisionAction | null
  finalReasonCode: LeadDecisionResult['reasonCode'] | null
  actionsExecuted: ExecutedAction[]
  iterationCount: number
  stoppedBecause: OrchestrationStopCause
  retryable: boolean
}

export interface ExecutorInput {
  client: SupabaseClient<Database>
  context: LeadDecisionContext
  decision: LeadDecisionResult
  request: OrchestrationRequest
  iteration: number
}

export type LeadExecutor = (input: ExecutorInput) => Promise<ExecutorResult>
export type ExecutorRegistry = Partial<Record<DecisionAction, LeadExecutor>>

export interface OrchestratorTelemetry {
  startWorkflowRun(input: Record<string, unknown>): Promise<string | null>
  completeWorkflowRun(id: string | null, status?: 'succeeded' | 'partial' | 'skipped' | 'waiting' | 'cancelled', metadata?: Record<string, unknown>): Promise<boolean>
  failWorkflowRun(id: string | null, error: unknown, metadata?: Record<string, unknown>): Promise<boolean>
  startWorkflowStep(input: Record<string, unknown>): Promise<string | null>
  completeWorkflowStep(id: string | null, input?: Record<string, unknown>): Promise<boolean>
  failWorkflowStep(id: string | null, error: unknown, metadata?: Record<string, unknown>): Promise<boolean>
}

export interface OrchestratorDependencies {
  client: SupabaseClient<Database>
  telemetry: OrchestratorTelemetry
  executors: ExecutorRegistry
  loadContext(leadId: string): Promise<LeadDecisionContext | null>
  decide(context: LeadDecisionContext): LeadDecisionResult
  compareLegacy?(context: LeadDecisionContext): { legacyAction: DecisionAction; classification: string; note: string }
  acquireLeadLock(leadId: string): Promise<string | null>
  releaseLeadLock(leadId: string, token: string): Promise<void>
  now?: () => number
}
