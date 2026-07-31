import 'server-only'

import type { AIProvider } from './AIProvider'
import { AnthropicProvider } from './providers/AnthropicProvider'
import { GeminiProvider } from './providers/GeminiProvider'
import { OpenAIProvider } from './providers/OpenAIProvider'
import { estimateCost } from './observability/pricing'
import { getRetryCount } from './observability/retry-count'
import { aiRequestLogger } from './observability/runtime'
import { sanitizeAIErrorMessage } from './observability/sanitize-error'

function createProvider(providerKey: string): AIProvider {
  switch (providerKey) {
    case 'anthropic':
      return new AnthropicProvider()
    case 'openai':
      return new OpenAIProvider()
    case 'gemini':
      return new GeminiProvider()
    default:
      throw new Error(`AI provider "${providerKey}" is not registered`)
  }
}

export async function testProviderConnection(providerKey: string, modelKey: string): Promise<void> {
  const provider = createProvider(providerKey)
  const prompt = 'Reply with OK.'
  const startedAtMs = Date.now()

  try {
    const response = await provider.generate({
      workflow: 'website_extraction',
      model: modelKey,
      maxTokens: 16,
      messages: [{ role: 'user', content: prompt }],
    })
    const finishedAtMs = Date.now()
    aiRequestLogger.record({
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      workflow: 'provider_connection_test',
      provider: providerKey,
      model: modelKey,
      status: 'succeeded',
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
      inputTokens: response.usage?.inputTokens ?? null,
      outputTokens: response.usage?.outputTokens ?? null,
      totalTokens: response.usage?.totalTokens ?? null,
      estimatedCostUsd: estimateCost(
        providerKey,
        modelKey,
        response.usage?.inputTokens,
        response.usage?.outputTokens
      ),
      errorMessage: null,
      retryCount: response.retryCount ?? 0,
      requestSource: 'settings_connection_test',
      metadata: { max_tokens: 16, message_count: 1, has_system_prompt: false },
    })
  } catch (error) {
    const finishedAtMs = Date.now()
    aiRequestLogger.record({
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      workflow: 'provider_connection_test',
      provider: providerKey,
      model: modelKey,
      status: 'failed',
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
      errorMessage: sanitizeAIErrorMessage(error, [
        prompt,
        process.env.ANTHROPIC_API_KEY,
        process.env.OPENAI_API_KEY,
        process.env.GEMINI_API_KEY,
      ]),
      retryCount: getRetryCount(error),
      requestSource: 'settings_connection_test',
      metadata: { max_tokens: 16, message_count: 1, has_system_prompt: false },
    })
    throw error
  }
}
