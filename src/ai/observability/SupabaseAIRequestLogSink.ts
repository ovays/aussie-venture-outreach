import { createServiceClient } from '@/lib/supabase/server'
import type { AIRequestLog, AIRequestLogSink } from './AIRequestLogger'
import { currentWorkflowTrace } from '@/lib/observability/context'

export class SupabaseAIRequestLogSink implements AIRequestLogSink {
  async write(log: AIRequestLog): Promise<void> {
    const trace = currentWorkflowTrace()
    const { error } = await createServiceClient()
      .from('ai_request_logs')
      .insert({
        created_at: log.startedAt,
        started_at: log.startedAt,
        finished_at: log.finishedAt,
        workflow: log.workflow,
        provider: log.provider,
        model: log.model,
        status: log.status,
        duration_ms: log.durationMs,
        input_tokens: log.inputTokens,
        output_tokens: log.outputTokens,
        total_tokens: log.totalTokens,
        estimated_cost_usd: log.estimatedCostUsd,
        error_message: log.errorMessage,
        retry_count: log.retryCount,
        request_source: log.requestSource,
        provider_request_id: log.providerRequestId ?? null,
        workflow_run_id: trace?.workflowRunId ?? null,
        workflow_step_id: trace?.workflowStepId ?? null,
        metadata: log.metadata,
      })

    if (error) throw new Error(error.message)
  }
}
