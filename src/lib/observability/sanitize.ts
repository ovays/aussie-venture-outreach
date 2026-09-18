const MAX_DEPTH = 5
const MAX_KEYS = 80
const MAX_ARRAY = 40
const MAX_STRING = 500
export const MAX_OBSERVABILITY_JSON_BYTES = 16_384

export type SafeMetadata = Record<string, unknown>

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (['inputtokens', 'outputtokens', 'totaltokens', 'tokencount'].includes(normalized)) return false
  return normalized.includes('apikey') || normalized.includes('authorization')
    || normalized.includes('password') || normalized.includes('secret')
    || normalized === 'token' || normalized.endsWith('token')
    || normalized.includes('servicerole') || normalized.includes('cookie')
    || normalized.includes('oauth') || normalized === 'prompt' || normalized.endsWith('prompt')
    || normalized === 'payload' || normalized === 'content'
    || normalized.includes('messagebody') || normalized === 'body'
    || normalized === 'bodyhtml' || normalized === 'bodytext'
}

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{8,}/gi, '[REDACTED]')
    .slice(0, MAX_STRING)
}

function clean(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED_DEPTH]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return redactString(value)
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => clean(item, depth + 1))
  if (typeof value !== 'object') return String(value).slice(0, MAX_STRING)

  const output: SafeMetadata = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
    output[key] = isSensitiveKey(key) ? '[REDACTED]' : clean(item, depth + 1)
  }
  return output
}

export function sanitizeObservabilityMetadata(value: unknown): SafeMetadata {
  const sanitized = clean(value && typeof value === 'object' && !Array.isArray(value) ? value : {}, 0) as SafeMetadata
  const encoded = JSON.stringify(sanitized)
  if (Buffer.byteLength(encoded, 'utf8') <= MAX_OBSERVABILITY_JSON_BYTES) return sanitized
  return {
    truncated: true,
    original_bytes: Buffer.byteLength(encoded, 'utf8'),
    keys: Object.keys(sanitized).slice(0, 40),
  }
}

export function sanitizeErrorMessage(value: unknown): string {
  const message = value instanceof Error ? value.message
    : typeof value === 'object' && value !== null && 'message' in value
      ? String((value as { message?: unknown }).message ?? 'Unknown error')
      : String(value ?? 'Unknown error')
  return redactString(message)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]')
    .slice(0, 1000)
}
