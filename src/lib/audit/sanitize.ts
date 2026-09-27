const SENSITIVE_KEY = /^(password|token|access_?token|refresh_?token|secret|api_?key|authorization|cookie|client_?secret|service_?role(?:_?key)?|encryption_?key|webhook_?secret|session|credentials?|private_?key|payload|raw_?payload|request_?body|response_?body|oauth_?payload|stripe_?payload|email_?payload)$/i

const REDACTED = '[REDACTED]'

/**
 * Defensively redacts secret-like keys anywhere in a JSON value. It never
 * throws: non-object values pass through unchanged and malformed shapes degrade
 * to an empty object. The database writer applies the same policy independently.
 */
export function sanitizeAuditMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditMetadata(item))
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitizeAuditMetadata(child)
    }
    return out
  }
  return value
}
