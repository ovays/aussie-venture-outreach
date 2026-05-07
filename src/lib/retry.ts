export interface RetryOptions {
  maxAttempts: number
  baseDelayMs: number
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < opts.maxAttempts) {
        await new Promise(r => setTimeout(r, opts.baseDelayMs * Math.pow(2, attempt - 1)))
      }
    }
  }
  throw lastError
}
