import assert from 'node:assert/strict'
import type { GoogleGenAI } from '@google/genai'
import {
  AIConfigurationService,
  validateConfiguration,
} from '@/ai/configuration/AIConfigurationService'
import { AI_WORKFLOWS } from '@/ai/configuration/AIConfiguration'
import type {
  AIConfigurationRepository,
  AIWorkflowConfigurationRecord,
} from '@/ai/configuration/AIConfigurationRepository'
import { AIRegistry } from '@/ai/AIRegistry'
import { AnthropicProvider } from '@/ai/providers/AnthropicProvider'
import { GeminiProvider } from '@/ai/providers/GeminiProvider'
import { OpenAIProvider } from '@/ai/providers/OpenAIProvider'
import type {
  AIGenerateRequest,
  AIGenerateResponse,
  AIProvider,
} from '@/ai/AIProvider'

const configuredRecords: readonly AIWorkflowConfigurationRecord[] = [
  { workflow: 'website_extraction', providerKey: 'test-provider', modelKey: 'website-model-from-db' },
  { workflow: 'contact_email_extraction', providerKey: 'test-provider', modelKey: 'email-model-from-db' },
  { workflow: 'agentic_email_search', providerKey: 'research-provider', modelKey: 'search-model-from-db' },
  { workflow: 'outreach_email_generation', providerKey: 'test-provider', modelKey: 'outreach-model-from-db' },
  { workflow: 'outreach_dm_generation', providerKey: 'dm-provider', modelKey: 'dm-model-from-db' },
  { workflow: 'reactivation_email_generation', providerKey: 'test-provider', modelKey: 'reactivation-model-from-db' },
]

class FakeRepository implements AIConfigurationRepository {
  calls = 0

  async loadWorkflowConfigurations(): Promise<readonly AIWorkflowConfigurationRecord[]> {
    this.calls += 1
    return configuredRecords
  }
}

class MutableRepository implements AIConfigurationRepository {
  constructor(public records: readonly AIWorkflowConfigurationRecord[]) {}

  async loadWorkflowConfigurations(): Promise<readonly AIWorkflowConfigurationRecord[]> {
    return this.records
  }
}

class FakeProvider implements AIProvider {
  requests: AIGenerateRequest[] = []

  async generate(request: AIGenerateRequest): Promise<AIGenerateResponse> {
    this.requests.push(request)
    return { text: 'generated' }
  }
}

async function verifyDatabaseProviderSwitching(): Promise<void> {
  const initialRecords = configuredRecords.map((record) => ({
    ...record,
    providerKey: 'anthropic',
    modelKey: record.workflow === 'outreach_dm_generation'
      ? 'claude-haiku-4-5-20251001'
      : 'claude-sonnet-4-6',
  }))
  const repository = new MutableRepository(initialRecords)
  const configurationService = new AIConfigurationService(repository)
  const anthropic = new FakeProvider()
  const openai = new FakeProvider()
  const gemini = new FakeProvider()
  const registry = new AIRegistry(configurationService)
    .register('anthropic', anthropic)
    .register('openai', openai)
    .register('gemini', gemini)

  const request = {
    maxTokens: 200,
    messages: [{ role: 'user' as const, content: 'hello' }],
  }

  await registry.generate('outreach_email_generation', request)
  await registry.generate('outreach_dm_generation', request)

  assert.equal(anthropic.requests.length, 2, 'Anthropic handles both initial database assignments')
  assert.equal(openai.requests.length, 0, 'OpenAI is inactive before the database assignments change')

  repository.records = initialRecords.map((record) => {
    if (record.workflow === 'outreach_email_generation') {
      return { ...record, providerKey: 'openai', modelKey: 'gpt-5' }
    }
    if (record.workflow === 'outreach_dm_generation') {
      return { ...record, providerKey: 'openai', modelKey: 'gpt-5-mini' }
    }
    return record
  })
  configurationService.invalidate()

  await registry.generate('outreach_email_generation', request)
  await registry.generate('outreach_dm_generation', request)

  assert.equal(anthropic.requests.length, 2, 'Anthropic receives no calls after the database-only switch')
  assert.equal(openai.requests.length, 2, 'OpenAI handles both switched database assignments')
  assert.deepEqual(
    openai.requests.map((providerRequest) => providerRequest.model),
    ['gpt-5', 'gpt-5-mini'],
    'database-selected OpenAI model IDs reach the provider unchanged'
  )

  repository.records = repository.records.map((record) => {
    if (record.workflow === 'outreach_email_generation') {
      return { ...record, providerKey: 'gemini', modelKey: 'gemini-2.5-pro' }
    }
    if (record.workflow === 'outreach_dm_generation') {
      return { ...record, providerKey: 'gemini', modelKey: 'gemini-2.5-flash' }
    }
    return record
  })
  configurationService.invalidate()

  await registry.generate('outreach_email_generation', request)
  await registry.generate('outreach_dm_generation', request)

  assert.equal(anthropic.requests.length, 2, 'Anthropic receives no calls after later database switches')
  assert.equal(openai.requests.length, 2, 'OpenAI receives no calls after the Gemini database switch')
  assert.equal(gemini.requests.length, 2, 'Gemini handles both database-switched assignments')
  assert.deepEqual(
    gemini.requests.map((providerRequest) => providerRequest.model),
    ['gemini-2.5-pro', 'gemini-2.5-flash'],
    'database-selected Gemini model IDs reach the provider unchanged'
  )
}

async function verifyOpenAIKeyValidation(): Promise<void> {
  const originalApiKey = process.env.OPENAI_API_KEY
  const originalGeminiApiKey = process.env.GEMINI_API_KEY
  const originalFetch = globalThis.fetch
  const request = {
    maxTokens: 200,
    messages: [{ role: 'user' as const, content: 'hello' }],
  }

  const recordsForProvider = (providerKey: 'anthropic' | 'openai') =>
    configuredRecords.map((record) => ({
      ...record,
      providerKey: record.workflow === 'outreach_email_generation'
        ? providerKey
        : 'anthropic',
    }))

  try {
    delete process.env.OPENAI_API_KEY
    delete process.env.GEMINI_API_KEY

    const anthropic = new FakeProvider()
    const anthropicRegistry = new AIRegistry(
      new AIConfigurationService(new MutableRepository(recordsForProvider('anthropic')))
    )
      .register('anthropic', anthropic)
      .register('openai', new OpenAIProvider())

    const anthropicResponse = await anthropicRegistry.generate(
      'outreach_email_generation',
      request
    )
    assert.equal(anthropicResponse.text, 'generated')
    assert.equal(
      anthropic.requests.length,
      1,
      'Anthropic workflows do not require OPENAI_API_KEY'
    )

    process.env.OPENAI_API_KEY = 'sk-test-openai-key'
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: 'resp_test',
      object: 'response',
      status: 'completed',
      output: [{
        id: 'msg_test',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: 'generated by OpenAI',
          annotations: [],
        }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

    const openAIRegistry = new AIRegistry(
      new AIConfigurationService(new MutableRepository(recordsForProvider('openai')))
    )
      .register('anthropic', new FakeProvider())
      .register('openai', new OpenAIProvider())

    const openAIResponse = await openAIRegistry.generate(
      'outreach_email_generation',
      request
    )
    assert.equal(openAIResponse.text, 'generated by OpenAI')

    delete process.env.OPENAI_API_KEY
    const missingKeyRegistry = new AIRegistry(
      new AIConfigurationService(new MutableRepository(recordsForProvider('openai')))
    )
      .register('anthropic', new FakeProvider())
      .register('openai', new OpenAIProvider())

    await assert.rejects(
      missingKeyRegistry.generate('outreach_email_generation', request),
      {
        message: 'OPENAI_API_KEY is required because workflow "outreach_email_generation" is configured to use the OpenAI provider.',
      },
      'OpenAI workflows report the provider, workflow, and missing environment variable'
    )
  } finally {
    globalThis.fetch = originalFetch
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY
    } else {
      process.env.OPENAI_API_KEY = originalApiKey
    }
    if (originalGeminiApiKey === undefined) {
      delete process.env.GEMINI_API_KEY
    } else {
      process.env.GEMINI_API_KEY = originalGeminiApiKey
    }
  }
}

async function verifyAnthropicKeyValidation(): Promise<void> {
  const originalApiKey = process.env.ANTHROPIC_API_KEY

  try {
    delete process.env.ANTHROPIC_API_KEY
    const registry = new AIRegistry(
      new AIConfigurationService(new MutableRepository(configuredRecords.map((record) => ({
        ...record,
        providerKey: 'anthropic',
      }))))
    ).register('anthropic', new AnthropicProvider())

    await assert.rejects(
      registry.generate('outreach_email_generation', {
        maxTokens: 200,
        messages: [{ role: 'user', content: 'hello' }],
      }),
      {
        message: 'ANTHROPIC_API_KEY is required because workflow "outreach_email_generation" is configured to use the Anthropic provider.',
      },
      'Anthropic workflows report the provider, workflow, and missing environment variable'
    )
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey
    }
  }
}

async function verifyGeminiKeyValidation(): Promise<void> {
  const originalApiKey = process.env.GEMINI_API_KEY
  const request = {
    maxTokens: 200,
    system: 'Be concise.',
    messages: [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'Hi.' },
    ],
  }
  const recordsForProvider = (providerKey: 'anthropic' | 'openai' | 'gemini') =>
    configuredRecords.map((record) => ({
      ...record,
      providerKey: record.workflow === 'outreach_email_generation'
        ? providerKey
        : 'anthropic',
      modelKey: record.workflow === 'outreach_email_generation' && providerKey === 'gemini'
        ? 'gemini-2.5-flash'
        : record.modelKey,
    }))

  const geminiRequests: unknown[] = []
  const mockGeminiClient = {
    models: {
      generateContent: async (providerRequest: unknown) => {
        geminiRequests.push(providerRequest)
        return { text: 'generated by Gemini' }
      },
    },
  } as unknown as GoogleGenAI

  try {
    delete process.env.GEMINI_API_KEY

    for (const providerKey of ['anthropic', 'openai'] as const) {
      const selectedProvider = new FakeProvider()
      const registry = new AIRegistry(
        new AIConfigurationService(new MutableRepository(recordsForProvider(providerKey)))
      )
        .register('anthropic', providerKey === 'anthropic' ? selectedProvider : new FakeProvider())
        .register('openai', providerKey === 'openai' ? selectedProvider : new FakeProvider())
        .register('gemini', new GeminiProvider(mockGeminiClient))

      const response = await registry.generate('outreach_email_generation', request)
      assert.equal(response.text, 'generated')
      assert.equal(
        selectedProvider.requests.length,
        1,
        `${providerKey} workflows do not require GEMINI_API_KEY`
      )
    }

    process.env.GEMINI_API_KEY = 'test-gemini-key'
    const geminiRegistry = new AIRegistry(
      new AIConfigurationService(new MutableRepository(recordsForProvider('gemini')))
    )
      .register('anthropic', new FakeProvider())
      .register('openai', new FakeProvider())
      .register('gemini', new GeminiProvider(mockGeminiClient))

    const geminiResponse = await geminiRegistry.generate(
      'outreach_email_generation',
      request
    )
    assert.equal(geminiResponse.text, 'generated by Gemini')
    assert.deepEqual(geminiRequests, [{
      model: 'gemini-2.5-flash',
      contents: [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'Hi.' }] },
      ],
      config: {
        maxOutputTokens: 200,
        systemInstruction: 'Be concise.',
      },
    }], 'Gemini receives the provider-neutral request through its SDK adapter')

    delete process.env.GEMINI_API_KEY
    const missingKeyRegistry = new AIRegistry(
      new AIConfigurationService(new MutableRepository(recordsForProvider('gemini')))
    )
      .register('anthropic', new FakeProvider())
      .register('openai', new FakeProvider())
      .register('gemini', new GeminiProvider(mockGeminiClient))

    await assert.rejects(
      missingKeyRegistry.generate('outreach_email_generation', request),
      {
        message: 'GEMINI_API_KEY is required because workflow "outreach_email_generation" is configured to use the Gemini provider.',
      },
      'Gemini workflows report the provider, workflow, and missing environment variable'
    )
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.GEMINI_API_KEY
    } else {
      process.env.GEMINI_API_KEY = originalApiKey
    }
  }
}

async function main() {
  const repository = new FakeRepository()
  let now = 1_000
  const configurationService = new AIConfigurationService(
    repository,
    500,
    () => now
  )

  const first = await configurationService.getConfiguration()
  const second = await configurationService.getConfiguration()
  assert.equal(first, second, 'configuration is reused within the cache window')
  assert.equal(repository.calls, 1, 'cached configuration performs one database load')

  now += 501
  await configurationService.getConfiguration()
  assert.equal(repository.calls, 2, 'expired configuration is loaded again')

  configurationService.invalidate()
  await configurationService.getConfiguration()
  assert.equal(repository.calls, 3, 'explicit invalidation reloads configuration')

  const defaultProvider = new FakeProvider()
  const dmProvider = new FakeProvider()
  const registry = new AIRegistry(configurationService)
    .register('test-provider', defaultProvider)
    .register('dm-provider', dmProvider)

  const response = await registry.generate('outreach_dm_generation', {
    maxTokens: 200,
    messages: [{ role: 'user', content: 'hello' }],
  })

  assert.equal(response.text, 'generated')
  assert.equal(defaultProvider.requests.length, 0)
  assert.equal(dmProvider.requests.length, 1)
  assert.equal(
    dmProvider.requests[0].model,
    'dm-model-from-db',
    'registry injects the database-selected workflow provider and model'
  )
  assert.deepEqual(
    dmProvider.requests[0].messages,
    [{ role: 'user', content: 'hello' }],
    'registry preserves the provider request'
  )

  assert.throws(
    () => validateConfiguration([]),
    /configuration is missing workflows/,
    'configuration validation rejects missing workflow mappings'
  )

  assert.equal(
    AI_WORKFLOWS.length,
    configuredRecords.length,
    'the test fixture covers every supported workflow'
  )

  await verifyDatabaseProviderSwitching()
  await verifyAnthropicKeyValidation()
  await verifyOpenAIKeyValidation()
  await verifyGeminiKeyValidation()

  console.log('AI configuration tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
