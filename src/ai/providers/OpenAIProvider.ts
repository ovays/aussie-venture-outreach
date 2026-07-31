import OpenAI from 'openai'
import { withRetry } from '../../lib/retry'
import type { AIGenerateRequest, AIGenerateResponse, AIProvider } from '../AIProvider'
import { attachRetryCount } from '../observability/retry-count'
import { extractOpenAIUsage } from '../observability/usage'

const RATE_LIMIT = 20

export class OpenAIProvider implements AIProvider {
  private client: OpenAI | undefined

  private callCount = 0
  private callWindowStart = Date.now()

  async generate(request: AIGenerateRequest): Promise<AIGenerateResponse> {
    let retryCount = 0
    try {
      const response = await this.rateLimitedCall(
        () => this.getClient(request.workflow).responses.create({
          model: request.model,
          max_output_tokens: request.maxTokens,
          ...(request.system ? { instructions: request.system } : {}),
          input: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        }),
        () => { retryCount += 1 }
      )

      return {
        text: response.output_text,
        usage: extractOpenAIUsage(response.usage),
        retryCount,
      }
    } catch (error) {
      attachRetryCount(error, retryCount)
      throw error
    }
  }

  private getClient(workflow: AIGenerateRequest['workflow']): OpenAI {
    if (!this.client) {
      const apiKey = process.env.OPENAI_API_KEY
      if (!apiKey?.trim()) {
        throw new Error(
          `OPENAI_API_KEY is required because workflow "${workflow}" is configured to use the OpenAI provider.`
        )
      }

      this.client = new OpenAI({
        apiKey,
        maxRetries: 0,
      })
    }
    return this.client
  }

  private isTransientError(error: unknown): boolean {
    if (error instanceof OpenAI.APIError) {
      return error.status === 429 || (error.status !== undefined && error.status >= 500)
    }
    const message = error instanceof Error ? error.message : String(error)
    const normalized = message.toLowerCase()
    return message.includes('429') || normalized.includes('rate limit') || normalized.includes('overloaded')
  }

  private async rateLimitedCall<T>(call: () => Promise<T>, onRetry: () => void): Promise<T> {
    const now = Date.now()
    if (now - this.callWindowStart > 60_000) {
      this.callCount = 0
      this.callWindowStart = now
    }
    if (this.callCount >= RATE_LIMIT) {
      const wait = 60_000 - (now - this.callWindowStart)
      await new Promise((resolve) => setTimeout(resolve, wait))
      this.callCount = 0
      this.callWindowStart = Date.now()
    }
    this.callCount++

    // 3 retries (4 total attempts) for transient provider errors: delays ~1s, 2s, 4s
    return withRetry(call, {
      maxAttempts: 4,
      baseDelayMs: 1000,
      isRetryable: (error) => this.isTransientError(error),
      onRetry,
    })
  }
}
