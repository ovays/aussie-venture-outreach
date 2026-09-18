export interface ServiceExecutionResult {
  outcome: 'completed' | 'skipped' | 'waiting' | 'failed'
  changedState: boolean
  retryable?: boolean
  details?: Readonly<Record<string, string | number | boolean | null>>
}

export function serviceFailure(reason: string, retryable = false): ServiceExecutionResult {
  return { outcome: 'failed', changedState: false, retryable, details: { reason } }
}
