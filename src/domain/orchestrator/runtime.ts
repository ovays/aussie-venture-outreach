import { compareDecisionWithLegacy, decideNextAction, loadDecisionContext, loadDecisionContexts } from '@/domain/decision-engine'
import type { LeadDecisionContext } from '@/domain/decision-engine'
import { createServiceClient } from '@/lib/supabase/server'
import { acquireLock, releaseLock } from '@/lib/distributed-lock'
import { observability } from '@/lib/observability/service'
import { createProductionExecutorRegistry } from './executors'
import { orchestrateLead } from './orchestrate-lead'
import { orchestrateLeadBatch, MAX_ORCHESTRATION_BATCH_SIZE } from './batch'
import { readOrchestratorFlags } from './flags'
import {
  assertCanaryAllowlistLeadId,
  assertCanarySingleRun,
  isV2CanaryEnabled,
  V2_CANARY_WORKFLOW_TYPE,
} from '@/lib/v2-canary-safety'
import type { OrchestrationRequest, OrchestrationResult, OrchestratorDependencies } from './types'
import type { Database } from '@/types/database'
import type { SupabaseClient } from '@supabase/supabase-js'

const LEAD_LOCK_TTL_MS = 30 * 60 * 1000

function dependencies(
  client: SupabaseClient<Database>,
  firstContext?: LeadDecisionContext,
): OrchestratorDependencies {
  let seed = firstContext
  return {
    client,
    telemetry: observability() as unknown as OrchestratorDependencies['telemetry'],
    executors: createProductionExecutorRegistry(),
    loadContext: async (leadId) => {
      if (seed?.leadId === leadId) {
        const current = seed
        seed = undefined
        return current
      }
      return loadDecisionContext(client, leadId)
    },
    decide: decideNextAction,
    compareLegacy: compareDecisionWithLegacy,
    acquireLeadLock: (leadId) => acquireLock(client, `orchestrator:lead:${leadId}`, LEAD_LOCK_TTL_MS),
    releaseLeadLock: (leadId, token) => releaseLock(client, `orchestrator:lead:${leadId}`, token),
  }
}

export async function runLeadOrchestration(request: OrchestrationRequest): Promise<OrchestrationResult> {
  if (request.shadow) throw new Error('Operational Orchestrator shadow is disabled; use evaluateLeadShadow().')
  if (isV2CanaryEnabled()) {
    assertCanarySingleRun()
    assertCanaryAllowlistLeadId(request.leadId)
    if (request.workflowType !== V2_CANARY_WORKFLOW_TYPE) throw new Error('V2 canary only permits the dedicated exact-lead workflow.')
    if ((request.maxIterations ?? 1) !== 1) throw new Error('V2 canary requires maxIterations=1.')
  }
  const client = createServiceClient() as SupabaseClient<Database>
  return orchestrateLead(request, dependencies(client))
}

export interface SelectOrchestrationCandidatesOptions {
  limit?: number
}

export async function selectOrchestrationCandidateIds(
  client: SupabaseClient<Database>,
  options: SelectOrchestrationCandidatesOptions = {},
): Promise<string[]> {
  const limit = Math.max(1, Math.min(options.limit ?? MAX_ORCHESTRATION_BATCH_SIZE, MAX_ORCHESTRATION_BATCH_SIZE))
  const result = await client.from('leads').select('id')
    .in('status', ['new', 'researched', 'email_ready', 'contacted'])
    .order('updated_at', { ascending: true }).order('id', { ascending: true }).limit(limit)
  if (result.error) throw new Error(`Orchestrator candidate selection failed: ${result.error.message}`)
  return (result.data ?? []).map((lead) => lead.id)
}

export async function runConfiguredLeadBatch(input: {
  leadIds: readonly string[]
  source: string
  triggerRunId?: string
  parentRunId?: string
  correlationId?: string
  attempt?: number
}): Promise<ReturnType<typeof orchestrateLeadBatch> extends Promise<infer T> ? T : never> {
  if (input.leadIds.length > MAX_ORCHESTRATION_BATCH_SIZE) throw new Error(`Orchestration batch exceeds ${MAX_ORCHESTRATION_BATCH_SIZE} leads`)
  if (isV2CanaryEnabled()) throw new Error('V2 canary forbids broad orchestration batches.')
  const client = createServiceClient() as SupabaseClient<Database>
  const flags = readOrchestratorFlags()
  if (flags.shadow) throw new Error('Operational Orchestrator shadow is disabled; use the dedicated shadow evaluator.')
  if (!flags.enabled) throw new Error('Orchestrator is disabled')
  const loaded = await loadDecisionContexts(client, input.leadIds)
  const contextByLeadId = new Map(loaded.contexts.map((context) => [context.leadId, context]))
  const requests = input.leadIds.map((leadId): OrchestrationRequest => ({
    workflowType: 'lead_lifecycle', leadId, source: input.source,
    triggerRunId: input.triggerRunId, parentRunId: input.parentRunId,
    correlationId: input.correlationId, attempt: input.attempt,
    shadow: false,
  }))
  return orchestrateLeadBatch(requests, (request) => orchestrateLead(request, dependencies(client, contextByLeadId.get(request.leadId))))
}
