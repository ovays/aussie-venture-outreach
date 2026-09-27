// Safe AI error taxonomy. These categories are observability-only: they never
// grant authority and are surfaced to the caller as a controlled failure state
// rather than a raw provider stack trace.

export const AI_ERROR_CODES = [
  'AI_CONFIG_INVALID',
  'AI_QUOTA_DENIED',
  'AI_TIMEOUT',
  'AI_PROVIDER_RATE_LIMIT',
  'AI_PROVIDER_FAILURE',
  'AI_OUTPUT_INVALID',
  'AI_CONTEXT_TOO_LARGE',
  'AI_WORKSPACE_MISMATCH',
  'AI_WORKSPACE_REQUIRED',
  'AI_PROVIDER_DISABLED',
  'AI_MODEL_DISALLOWED',
] as const

export type AIErrorCode = (typeof AI_ERROR_CODES)[number]

export interface AIErrorMeta {
  code: AIErrorCode
  retryable: boolean
}

const RETRYABLE = new Set<AIErrorCode>([
  'AI_TIMEOUT',
  'AI_PROVIDER_RATE_LIMIT',
  'AI_PROVIDER_FAILURE',
])

export class AIExecutionError extends Error {
  readonly code: AIErrorCode
  readonly retryable: boolean

  constructor(code: AIErrorCode, message: string, retryable = RETRYABLE.has(code)) {
    super(message)
    this.name = 'AIExecutionError'
    this.code = code
    this.retryable = retryable
  }
}

/**
 * Classify an arbitrary provider/application error into a safe category.
 * The returned string never contains raw provider payloads or secrets.
 */
export function classifyAIError(error: unknown): AIErrorMeta {
  if (error instanceof AIExecutionError) {
    return { code: error.code, retryable: error.retryable }
  }
  const message = error instanceof Error ? error.message : String(error ?? '')
  const lower = message.toLowerCase()

  if (/timeout|timed out|abort/i.test(lower)) return { code: 'AI_TIMEOUT', retryable: true }
  if (/429|rate.?limit/i.test(lower)) return { code: 'AI_PROVIDER_RATE_LIMIT', retryable: true }
  if (/quota|entitlement/i.test(lower)) return { code: 'AI_QUOTA_DENIED', retryable: false }
  if (/workspace/i.test(lower)) return { code: 'AI_WORKSPACE_MISMATCH', retryable: false }
  if (/not registered|not allowed|disallowed|disabled/i.test(lower)) return { code: 'AI_CONFIG_INVALID', retryable: false }
  if (/schema|invalid|malformed|output|shape/i.test(lower)) return { code: 'AI_OUTPUT_INVALID', retryable: false }
  if (/context.*(large|limit|too)|too large/i.test(lower)) return { code: 'AI_CONTEXT_TOO_LARGE', retryable: false }
  if (/openai|anthropic|gemini|provider|5\d\d|529|overloaded/i.test(lower)) {
    return { code: 'AI_PROVIDER_FAILURE', retryable: true }
  }
  return { code: 'AI_PROVIDER_FAILURE', retryable: false }
}

export function isAIExecutionError(error: unknown): error is AIExecutionError {
  return error instanceof AIExecutionError
}
