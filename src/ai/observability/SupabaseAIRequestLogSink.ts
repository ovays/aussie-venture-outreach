import { createServiceClient } from '@/lib/supabase/server'
import type { AIRequestLog, AIRequestLogSink } from './AIRequestLogger'

export class SupabaseAIRequestLogSink implements AIRequestLogSink {
  async write(log: AIRequestLog): Promise<void> {
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
        metadata: log.metadata,
      })

    if (error) throw new Error(error.message)
  }
}
