export interface RetryOptions {
  maxAttempts: number
  baseDelayMs: number
  isRetryable?: (err: unknown) => boolean
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const isLast = attempt === opts.maxAttempts
      const retryable = opts.isRetryable ? opts.isRetryable(err) : true
      if (isLast || !retryable) throw err
      await new Promise(r => setTimeout(r, opts.baseDelayMs * Math.pow(2, attempt - 1)))
    }
  }
  throw new Error('withRetry: unreachable')
}
