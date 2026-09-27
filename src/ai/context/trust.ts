// Explicit trust classification for every piece of content that reaches an AI
// prompt. The harness renders these levels differently: trusted instructions are
// presented as rules to follow, while untrusted levels are delimited as DATA
// ONLY and can never carry authority.

export const AI_TRUST_LEVELS = [
  'trusted_system',
  'trusted_application',
  'workspace_configuration',
  'internal_data',
  'external_untrusted',
  'user_untrusted',
] as const

export type AITrustLevel = (typeof AI_TRUST_LEVELS)[number]

/**
 * Levels whose content is authoritative application instruction. They may be
 * presented to the model as rules to follow.
 */
export const TRUSTED_LEVELS: ReadonlySet<AITrustLevel> = new Set([
  'trusted_system',
  'trusted_application',
  'workspace_configuration',
  'internal_data',
])

/**
 * Levels whose content is data the model may read but must never treat as
 * instruction, tool, policy, workspace identity or authority. These are rendered
 * inside explicit delimiters and are bounded independently.
 */
export const UNTRUSTED_LEVELS: ReadonlySet<AITrustLevel> = new Set([
  'external_untrusted',
  'user_untrusted',
])

export function isUntrustedLevel(level: AITrustLevel): boolean {
  return UNTRUSTED_LEVELS.has(level)
}

export function isTrustedLevel(level: AITrustLevel): boolean {
  return TRUSTED_LEVELS.has(level)
}
