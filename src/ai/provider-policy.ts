import { AIExecutionError } from './errors'

// Centralised provider/model safety. A browser or model output can never select
// an arbitrary provider or model: only the registry's DB-driven workflow
// assignment may choose, and the harness re-validates that choice here so a
// misconfiguration fails closed rather than invoking an unknown backend.

export const AI_PROVIDER_KEYS = ['anthropic', 'openai', 'gemini'] as const
export type AIProviderKey = (typeof AI_PROVIDER_KEYS)[number]

const PROVIDER_SET = new Set<string>(AI_PROVIDER_KEYS)

const MODEL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isAllowedProviderKey(value: unknown): value is AIProviderKey {
  return typeof value === 'string' && PROVIDER_SET.has(value)
}

export function isAllowedModelKey(value: unknown): value is string {
  return typeof value === 'string' && MODEL_KEY_PATTERN.test(value)
}

export function assertProviderAllowed(providerKey: string): asserts providerKey is AIProviderKey {
  if (!isAllowedProviderKey(providerKey)) {
    throw new AIExecutionError('AI_CONFIG_INVALID', `AI provider "${providerKey}" is not allowed`, false)
  }
}

export function assertModelAllowed(modelKey: string): void {
  if (!isAllowedModelKey(modelKey)) {
    throw new AIExecutionError('AI_MODEL_DISALLOWED', `AI model "${modelKey}" is not allowed`, false)
  }
}
