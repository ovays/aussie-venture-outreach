import 'server-only'

import { aiRequestIdempotencyKey, discoveryIdempotencyKey, outboundEmailIdempotencyKey } from './keys'
import { consumeQuota } from './service'
import { isQuotaExceededError, QuotaExceededError } from './errors'

/**
 * Signature injected into the AI registry so it can enforce AI quota without
 * depending on the Supabase service client (keeping the registry unit-testable).
 */
export type QuotaConsumeFn = (workspaceId: string, idempotencyKey: string) => Promise<void>

export const consumeAIRequestQuota: QuotaConsumeFn = async (workspaceId, idempotencyKey) => {
  await consumeQuota(workspaceId, 'ai_request', aiRequestIdempotencyKey(idempotencyKey))
}

export async function consumeOutboundEmailQuota(workspaceId: string, emailIntentId: string): Promise<void> {
  await consumeQuota(workspaceId, 'outbound_email', outboundEmailIdempotencyKey(emailIntentId))
}

export async function consumeDiscoveryRequestQuota(
  workspaceId: string,
  provider: string,
  query: string,
  skip: number,
): Promise<void> {
  await consumeQuota(workspaceId, 'discovery_request', discoveryIdempotencyKey(provider, query, skip))
}

export function rethrowAsQuotaExceeded(error: unknown, dimension: string): never {
  if (isQuotaExceededError(error)) throw error
  throw new QuotaExceededError(dimension, error instanceof Error ? error.message : String(error))
}
