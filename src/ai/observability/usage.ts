import type { AITokenUsage } from '../AIProvider'

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null
}

export function normalizeTokenUsage(
  input: unknown,
  output: unknown,
  total?: unknown
): AITokenUsage | undefined {
  const inputTokens = tokenCount(input)
  const outputTokens = tokenCount(output)
  const suppliedTotal = tokenCount(total)
  const totalTokens = suppliedTotal ?? (
    inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens
      : null
  )

  if (inputTokens === null && outputTokens === null && totalTokens === null) {
    return undefined
  }

  return { inputTokens, outputTokens, totalTokens }
}

export function extractAnthropicUsage(value: unknown): AITokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Record<string, unknown>
  return normalizeTokenUsage(usage.input_tokens, usage.output_tokens)
}

export function extractOpenAIUsage(value: unknown): AITokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Record<string, unknown>
  return normalizeTokenUsage(usage.input_tokens, usage.output_tokens, usage.total_tokens)
}

export function extractGeminiUsage(value: unknown): AITokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as Record<string, unknown>
  return normalizeTokenUsage(
    usage.promptTokenCount,
    usage.candidatesTokenCount,
    usage.totalTokenCount
  )
}
