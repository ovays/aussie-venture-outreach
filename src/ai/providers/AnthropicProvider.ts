import Anthropic, { APIError } from '@anthropic-ai/sdk'
import { withRetry } from '../../lib/retry'
import type { AIGenerateRequest, AIGenerateResponse, AIProvider } from '../AIProvider'
import { attachRetryCount } from '../observability/retry-count'
import { extractAnthropicUsage } from '../observability/usage'

const RATE_LIMIT = 20

export class AnthropicProvider implements AIProvider {
  private client: Anthropic | undefined

  private callCount = 0
  private callWindowStart = Date.now()

  async generate(request: AIGenerateRequest): Promise<AIGenerateResponse> {
    let retryCount = 0
    try {
      const response = await this.rateLimitedCall(
        () => this.getClient(request.workflow).messages.create({
          model: request.model,
          max_tokens: request.maxTokens,
          ...(request.system ? { system: request.system } : {}),
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        }),
        () => { retryCount += 1 }
      )

      return {
        text: response.content[0].type === 'text' ? response.content[0].text : '',
        usage: extractAnthropicUsage(response.usage),
        retryCount,
      }
    } catch (error) {
      attachRetryCount(error, retryCount)
      throw error
    }
  }

  private getClient(workflow: AIGenerateRequest['workflow']): Anthropic {
    if (!this.client) {
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey?.trim()) {
        throw new Error(
          `ANTHROPIC_API_KEY is required because workflow "${workflow}" is configured to use the Anthropic provider.`
        )
      }

      this.client = new Anthropic({
        apiKey,
        maxRetries: 0,
      })
    }
    return this.client
  }

  private is529Overload(error: unknown): boolean {
    if (error instanceof APIError) return error.status === 529
    const message = error instanceof Error ? error.message : String(error)
    return message.includes('529') || message.toLowerCase().includes('overloaded')
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

    // 3 retries (4 total attempts) for 529 overload: delays ~1s, 2s, 4s
    return withRetry(call, {
      maxAttempts: 4,
      baseDelayMs: 1000,
      isRetryable: (error) => this.is529Overload(error),
      onRetry,
    })
  }
}
