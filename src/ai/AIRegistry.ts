import type { AIGenerateRequest, AIGenerateResponse, AIProvider } from './AIProvider'
import type { AIWorkflow } from './configuration/AIConfiguration'
import type { AIConfigurationService } from './configuration/AIConfigurationService'
import {
  NoopAIRequestLogger,
  type AIRequestLog,
  type AIRequestLogEmitter,
} from './observability/AIRequestLogger'
import { estimateCost } from './observability/pricing'
import { getRetryCount } from './observability/retry-count'
import { sanitizeAIErrorMessage } from './observability/sanitize-error'

export class AIRegistry {
  private readonly providers = new Map<string, AIProvider>()

  constructor(
    private readonly configurationService: AIConfigurationService,
    private readonly requestLogger: AIRequestLogEmitter = new NoopAIRequestLogger(),
    private readonly now: () => number = Date.now,
    private readonly requestSource = 'application'
  ) {}

  register(name: string, provider: AIProvider): this {
    this.providers.set(name, provider)
    return this
  }

  private get(name: string): AIProvider {
    const provider = this.providers.get(name)
    if (!provider) {
      throw new Error(`AI provider "${name}" is not registered`)
    }
    return provider
  }

  async generate(
    workflow: AIWorkflow,
    request: Omit<AIGenerateRequest, 'model' | 'workflow'>
  ): Promise<AIGenerateResponse> {
    const startedAtMs = this.now()
    let providerKey: string | null = null
    let modelKey: string | null = null

    try {
      const assignment = await this.configurationService.getWorkflowAssignment(workflow)
      providerKey = assignment.providerKey
      modelKey = assignment.modelKey
      const provider = this.get(providerKey)
      const response = await provider.generate({
        ...request,
        workflow,
        model: modelKey,
      })

      const finishedAtMs = this.now()
      const usage = response.usage
      this.emitLog({
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        workflow,
        provider: providerKey,
        model: modelKey,
        status: 'succeeded',
        durationMs: Math.max(0, finishedAtMs - startedAtMs),
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        totalTokens: usage?.totalTokens ?? null,
        estimatedCostUsd: estimateCost(
          providerKey,
          modelKey,
          usage?.inputTokens,
          usage?.outputTokens
        ),
        errorMessage: null,
        retryCount: response.retryCount ?? 0,
        requestSource: this.requestSource,
        metadata: {
          max_tokens: request.maxTokens,
          message_count: request.messages.length,
          has_system_prompt: Boolean(request.system),
        },
      })

      return response
    } catch (error) {
      const finishedAtMs = this.now()
      this.emitLog({
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        workflow,
        provider: providerKey,
        model: modelKey,
        status: 'failed',
        durationMs: Math.max(0, finishedAtMs - startedAtMs),
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        estimatedCostUsd: null,
        errorMessage: sanitizeAIErrorMessage(error, [
          request.system,
          ...request.messages.map((item) => item.content),
          process.env.ANTHROPIC_API_KEY,
          process.env.OPENAI_API_KEY,
          process.env.GEMINI_API_KEY,
        ]),
        retryCount: getRetryCount(error),
        requestSource: this.requestSource,
        metadata: {
          max_tokens: request.maxTokens,
          message_count: request.messages.length,
          has_system_prompt: Boolean(request.system),
        },
      })
      throw error
    }
  }

  private emitLog(log: AIRequestLog): void {
    try {
      this.requestLogger.record(log)
    } catch (error) {
      console.error('[AI_OBSERVABILITY] Failed to dispatch AI request log', error)
    }
  }

}
