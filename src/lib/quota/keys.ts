import { createHash } from 'node:crypto'

// Stable idempotency keys for consumable quota dimensions. Kept free of any
// server-only dependency so boundary modules and tests can derive them without
// pulling in the Supabase client.

export function outboundEmailIdempotencyKey(emailIntentId: string): string {
  return `outbound_email:${emailIntentId}`
}

export function aiRequestIdempotencyKey(key: string): string {
  return `ai_request:${key}`
}

// Discovery is legitimately re-run each usage period, so the key must be stable
// for retries of the same query/page but distinct across queries and pages.
export function discoveryIdempotencyKey(provider: string, query: string, skip: number): string {
  const digest = createHash('sha256').update(`${provider}\u0000${query}\u0000${skip}`).digest('hex').slice(0, 40)
  return `discovery_request:${digest}`
}
