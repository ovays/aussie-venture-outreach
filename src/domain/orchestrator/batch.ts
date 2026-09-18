import type { OrchestrationRequest, OrchestrationResult } from './types'

export const MAX_ORCHESTRATION_BATCH_SIZE = 100
export const DEFAULT_ORCHESTRATION_CONCURRENCY = 4

export interface BatchOrchestrationResult {
  results: OrchestrationResult[]
  failedLeadIds: string[]
}

export async function orchestrateLeadBatch(
  requests: readonly OrchestrationRequest[],
  run: (request: OrchestrationRequest) => Promise<OrchestrationResult>,
  concurrency = DEFAULT_ORCHESTRATION_CONCURRENCY,
): Promise<BatchOrchestrationResult> {
  if (requests.length > MAX_ORCHESTRATION_BATCH_SIZE) throw new Error(`Orchestration batch exceeds ${MAX_ORCHESTRATION_BATCH_SIZE} leads`)
  const width = Math.max(1, Math.min(Math.floor(concurrency), 10))
  const results = new Array<OrchestrationResult>(requests.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(width, requests.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= requests.length) return
      try {
        results[index] = await run(requests[index])
      } catch {
        results[index] = {
          leadId: requests[index].leadId, workflowRunId: null, status: 'failed', finalAction: null,
          finalReasonCode: null, actionsExecuted: [], iterationCount: 0,
          stoppedBecause: 'EXECUTOR_FAILED', retryable: true,
        }
      }
    }
  }))
  return { results, failedLeadIds: results.filter((result) => result.status === 'failed').map((result) => result.leadId) }
}
