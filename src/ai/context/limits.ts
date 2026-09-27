// Deterministic context-size bounds. These stop scraped pages, inbound emails
// and arbitrary user text from producing unbounded AI consumption. Each
// workflow may tighten these; the defaults are the shared ceiling.

export interface AIContextLimits {
  /** Hard cap on a single untrusted item (website, email, scraped text). */
  maxUntrustedItemChars: number
  /** Combined cap across all untrusted items in one request. */
  maxUntrustedChars: number
  /** Combined cap across trusted instruction/configuration/internal data. */
  maxTrustedChars: number
  /** Hard cap on the total rendered request context. */
  maxTotalChars: number
}

export const DEFAULT_CONTEXT_LIMITS: AIContextLimits = {
  maxUntrustedItemChars: 4_000,
  maxUntrustedChars: 8_000,
  maxTrustedChars: 16_000,
  maxTotalChars: 20_000,
}

/** Truncate a string to a fixed length without splitting surrogate pairs. */
export function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false }
  let end = maxChars
  if (end > 0) {
    const code = value.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end -= 1
  }
  return { text: value.slice(0, end), truncated: true }
}
