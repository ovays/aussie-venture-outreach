interface RateLimitState {
  count: number
  resetAt: number
}

const store = new Map<string, RateLimitState>()

export function checkRateLimit(key: string, maxPerMinute: number): { allowed: boolean; remaining: number } {
  const now = Date.now()
  const state = store.get(key)

  if (!state || now >= state.resetAt) {
    store.set(key, { count: 1, resetAt: now + 60_000 })
    return { allowed: true, remaining: maxPerMinute - 1 }
  }

  if (state.count >= maxPerMinute) {
    return { allowed: false, remaining: 0 }
  }

  state.count++
  return { allowed: true, remaining: maxPerMinute - state.count }
}
