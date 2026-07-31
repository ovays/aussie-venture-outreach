import { ApiError, GoogleGenAI } from '@google/genai'
import { withRetry } from '../../lib/retry'
import type { AIGenerateRequest, AIGenerateResponse, AIProvider } from '../AIProvider'
import { attachRetryCount } from '../observability/retry-count'
import { extractGeminiUsage } from '../observability/usage'

const RATE_LIMIT = 20

export class GeminiProvider implements AIProvider {
  private client: GoogleGenAI | undefined

  private callCount = 0
  private callWindowStart = Date.now()

  constructor(client?: GoogleGenAI) {
    this.client = client
  }

  async generate(request: AIGenerateRequest): Promise<AIGenerateResponse> {
    let retryCount = 0
    try {
      const response = await this.rateLimitedCall(
        () => this.getClient(request.workflow).models.generateContent({
          model: request.model,
          contents: request.messages.map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
          config: {
            maxOutputTokens: request.maxTokens,
            ...(request.system ? { systemInstruction: request.system } : {}),
          },
        }),
        () => { retryCount += 1 }
      )

      return {
        text: response.text ?? '',
        usage: extractGeminiUsage(response.usageMetadata),
        retryCount,
      }
    } catch (error) {
      attachRetryCount(error, retryCount)
      throw error
    }
  }

  private getClient(workflow: AIGenerateRequest['workflow']): GoogleGenAI {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey?.trim()) {
      throw new Error(
        `GEMINI_API_KEY is required because workflow "${workflow}" is configured to use the Gemini provider.`
      )
    }

    if (!this.client) {
      this.client = new GoogleGenAI({
        apiKey,
        apiVersion: 'v1',
        httpOptions: {
          retryOptions: { attempts: 1 },
        },
      })
    }
    return this.client
  }

  private isTransientError(error: unknown): boolean {
    if (error instanceof ApiError) {
      return error.status === 429 || error.status >= 500
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
