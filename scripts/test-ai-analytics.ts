import assert from 'node:assert/strict'
import type { AIGenerateRequest, AIGenerateResponse, AIProvider } from '@/ai/AIProvider'
import { AIRegistry } from '@/ai/AIRegistry'
import type { AIWorkflow } from '@/ai/configuration/AIConfiguration'
import type { AIConfigurationRepository } from '@/ai/configuration/AIConfigurationRepository'
import { AIConfigurationService } from '@/ai/configuration/AIConfigurationService'
import {
  NonBlockingAIRequestLogger,
  type AIRequestLog,
  type AIRequestLogEmitter,
} from '@/ai/observability/AIRequestLogger'
import { estimateCost } from '@/ai/observability/pricing'
import { attachRetryCount } from '@/ai/observability/retry-count'
import {
  extractAnthropicUsage,
  extractGeminiUsage,
  extractOpenAIUsage,
} from '@/ai/observability/usage'

const workflows: AIWorkflow[] = [
  'website_extraction',
  'contact_email_extraction',
  'agentic_email_search',
  'outreach_email_generation',
  'outreach_dm_generation',
  'reactivation_email_generation',
]

class ConfigurationRepository implements AIConfigurationRepository {
  async loadWorkflowConfigurations() {
    return workflows.map((workflow) => ({
      workflow,
      providerKey: 'anthropic',
      modelKey: 'claude-sonnet-4-6',
    }))
  }
}

class Provider implements AIProvider {
  constructor(private readonly response: AIGenerateResponse | Error) {}

  async generate(_request: AIGenerateRequest): Promise<AIGenerateResponse> {
    if (this.response instanceof Error) throw this.response
    return this.response
  }
}

class MemoryLogger implements AIRequestLogEmitter {
  readonly logs: AIRequestLog[] = []
  record(log: AIRequestLog): void { this.logs.push(log) }
}

function clock(...values: number[]): () => number {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

function registry(provider: AIProvider, logger: AIRequestLogEmitter, now: () => number) {
  return new AIRegistry(
    new AIConfigurationService(new ConfigurationRepository()),
    logger,
    now,
    'analytics-test'
  ).register('anthropic', provider)
}

async function testSuccessfulRequest(): Promise<void> {
  const logger = new MemoryLogger()
  const response = await registry(new Provider({
    text: 'generated email must not be logged',
    usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
    retryCount: 1,
  }), logger, clock(1_000, 1_125)).generate('outreach_email_generation', {
    maxTokens: 500,
    system: 'private system prompt',
    messages: [{ role: 'user', content: 'private user prompt' }],
  })

  assert.equal(response.text, 'generated email must not be logged')
  assert.equal(logger.logs.length, 1)
  assert.equal(logger.logs[0].status, 'succeeded')
  assert.equal(logger.logs[0].durationMs, 125)
  assert.equal(logger.logs[0].provider, 'anthropic')
  assert.equal(logger.logs[0].model, 'claude-sonnet-4-6')
  assert.equal(logger.logs[0].totalTokens, 125)
  assert.equal(logger.logs[0].retryCount, 1)
  assert.equal(logger.logs[0].estimatedCostUsd, 0.000675)
  const serializedLog = JSON.stringify(logger.logs[0])
  assert.equal(serializedLog.includes('private user prompt'), false)
  assert.equal(serializedLog.includes('private system prompt'), false)
  assert.equal(serializedLog.includes('generated email must not be logged'), false)
}

async function testFailedRequest(): Promise<void> {
  const logger = new MemoryLogger()
  const providerError = new Error('provider unavailable for secret request body')
  attachRetryCount(providerError, 3)

  await assert.rejects(
    registry(new Provider(providerError), logger, clock(2_000, 2_340)).generate(
      'website_extraction',
      { maxTokens: 100, messages: [{ role: 'user', content: 'secret' }] }
    ),
    providerError
  )

  assert.equal(logger.logs.length, 1)
  assert.equal(logger.logs[0].status, 'failed')
  assert.equal(logger.logs[0].durationMs, 340)
  assert.equal(logger.logs[0].errorMessage, 'provider unavailable for [REDACTED] request body')
  assert.equal(logger.logs[0].retryCount, 3)
  assert.equal(logger.logs[0].inputTokens, null)
}

function testCostEstimation(): void {
  assert.equal(estimateCost('openai', 'gpt-5-mini', 1_000_000, 1_000_000), 2.25)
  assert.equal(estimateCost('unknown', 'model', 10, 20), null)
  assert.equal(estimateCost('openai', 'gpt-5', null, 20), null)
}

function testTokenExtraction(): void {
  assert.deepEqual(extractAnthropicUsage({ input_tokens: 12, output_tokens: 4 }), {
    inputTokens: 12, outputTokens: 4, totalTokens: 16,
  })
  assert.deepEqual(extractOpenAIUsage({ input_tokens: 9, output_tokens: 3, total_tokens: 12 }), {
    inputTokens: 9, outputTokens: 3, totalTokens: 12,
  })
  assert.deepEqual(extractGeminiUsage({ promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 30 }), {
    inputTokens: 20, outputTokens: 8, totalTokens: 30,
  })
  assert.equal(extractGeminiUsage(undefined), undefined)
}

async function testLoggingFailure(): Promise<void> {
  const errors: unknown[] = []
  const logger = new NonBlockingAIRequestLogger(
    { write: async () => { throw new Error('database offline') } },
    (_message, error) => { errors.push(error) }
  )
  const response = await registry(
    new Provider({ text: 'still generated' }),
    logger,
    clock(3_000, 3_010)
  ).generate('outreach_dm_generation', {
    maxTokens: 100,
    messages: [{ role: 'user', content: 'hello' }],
  })

  assert.equal(response.text, 'still generated', 'logging failure does not interrupt generation')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(errors.length, 1, 'logging failure is reported asynchronously')
}

async function testProviderWithoutUsage(): Promise<void> {
  const logger = new MemoryLogger()
  await registry(
    new Provider({ text: 'generated without usage' }),
    logger,
    clock(4_000, 4_001)
  ).generate('contact_email_extraction', {
    maxTokens: 100,
    messages: [{ role: 'user', content: 'hello' }],
  })

  assert.equal(logger.logs[0].inputTokens, null)
  assert.equal(logger.logs[0].outputTokens, null)
  assert.equal(logger.logs[0].totalTokens, null)
  assert.equal(logger.logs[0].estimatedCostUsd, null)
}

async function main(): Promise<void> {
  await testSuccessfulRequest()
  await testFailedRequest()
  testCostEstimation()
  testTokenExtraction()
  await testLoggingFailure()
  await testProviderWithoutUsage()
  console.log('AI analytics tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
