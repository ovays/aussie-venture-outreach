import { sanitizeErrorMessage } from './sanitize'

export const ERROR_CATEGORIES = [
  'VALIDATION', 'DATABASE', 'PROVIDER', 'NETWORK', 'RATE_LIMIT', 'AUTH',
  'SUPPRESSION', 'CONFIGURATION', 'CONCURRENCY', 'TIMEOUT', 'UNKNOWN',
] as const
export type ObservabilityErrorCategory = (typeof ERROR_CATEGORIES)[number]

export interface NormalizedObservabilityError {
  category: ObservabilityErrorCategory
  code: string
  message: string
  retryable: boolean
}

export function normalizeObservabilityError(error: unknown): NormalizedObservabilityError {
  const objectMessage = typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message?: unknown }).message ?? '') : ''
  const raw = error instanceof Error ? `${error.name} ${error.message}` : objectMessage || String(error ?? '')
  const lower = raw.toLowerCase()
  const explicitCode = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '') : ''
  let category: ObservabilityErrorCategory = 'UNKNOWN'
  let retryable = false
  if (error instanceof Error && error.name === 'UncertainEmailDeliveryError') { category = 'NETWORK'; retryable = true }
  else if (/timeout|timed out|aborterror/.test(lower)) { category = 'TIMEOUT'; retryable = true }
  else if (/429|rate.?limit|quota/.test(lower)) { category = 'RATE_LIMIT'; retryable = true }
  else if (/fetch|network|econn|enotfound|socket|dns/.test(lower)) { category = 'NETWORK'; retryable = true }
  else if (/401|403|unauthori|forbidden|auth/.test(lower)) category = 'AUTH'
  else if (/supabase|postgres|database|sql|23505|22p02|pgrst/.test(lower) || /^[0-9]{5}$/.test(explicitCode)) { category = 'DATABASE'; retryable = /deadlock|timeout|connection|serialization/.test(lower) }
  else if (/resend|hostinger|outscraper|google places|openai|anthropic|gemini|provider/.test(lower)) { category = 'PROVIDER'; retryable = true }
  else if (/suppress|unsubscribe|ownership/.test(lower)) category = 'SUPPRESSION'
  else if (/config|not set|missing env|environment/.test(lower)) category = 'CONFIGURATION'
  else if (/lock|concurr|already running/.test(lower)) { category = 'CONCURRENCY'; retryable = true }
  else if (/valid|invalid|required|malformed/.test(lower)) category = 'VALIDATION'

  return {
    category,
    code: (explicitCode && /^[A-Za-z0-9_.-]{1,120}$/.test(explicitCode) ? explicitCode : `${category}_ERROR`),
    message: sanitizeErrorMessage(error),
    retryable,
  }
}
