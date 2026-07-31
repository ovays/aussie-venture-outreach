export type AIRequestStatus = 'succeeded' | 'failed'

export interface AIRequestLog {
  startedAt: string
  finishedAt: string
  workflow: string
  provider: string | null
  model: string | null
  status: AIRequestStatus
  durationMs: number
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  estimatedCostUsd: number | null
  errorMessage: string | null
  retryCount: number
  requestSource: string
  metadata: Readonly<Record<string, boolean | number | string | null>>
}

export interface AIRequestLogSink {
  write(log: AIRequestLog): Promise<void>
}

export interface AIRequestLogEmitter {
  record(log: AIRequestLog): void
}

export class NoopAIRequestLogger implements AIRequestLogEmitter {
  record(_log: AIRequestLog): void {}
}

export class NonBlockingAIRequestLogger implements AIRequestLogEmitter {
  constructor(
    private readonly sink: AIRequestLogSink,
    private readonly reportError: (message: string, error: unknown) => void = console.error
  ) {}

  record(log: AIRequestLog): void {
    try {
      void this.sink.write(log).catch((error) => {
        this.reportError('[AI_OBSERVABILITY] Failed to persist AI request log', error)
      })
    } catch (error) {
      this.reportError('[AI_OBSERVABILITY] Failed to start AI request logging', error)
    }
  }
}
