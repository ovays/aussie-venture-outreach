const retryCountKey = Symbol('aiRetryCount')

type ErrorWithRetryCount = { [retryCountKey]?: number }

export function attachRetryCount(error: unknown, retryCount: number): void {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    try {
      Object.defineProperty(error, retryCountKey, {
        configurable: true,
        value: retryCount,
      })
    } catch {
      // Some third-party error objects are not extensible. Logging remains optional.
    }
  }
}

export function getRetryCount(error: unknown): number {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return 0
  const value = (error as ErrorWithRetryCount)[retryCountKey]
  return typeof value === 'number' && value >= 0 ? value : 0
}
