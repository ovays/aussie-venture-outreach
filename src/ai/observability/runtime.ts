import { NonBlockingAIRequestLogger } from './AIRequestLogger'
import { SupabaseAIRequestLogSink } from './SupabaseAIRequestLogSink'

export const aiRequestLogger = new NonBlockingAIRequestLogger(
  new SupabaseAIRequestLogSink()
)
