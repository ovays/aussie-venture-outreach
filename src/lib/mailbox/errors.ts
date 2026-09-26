export type MailboxErrorCode = 'AUTH_EXPIRED' | 'AUTH_REVOKED' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_RECIPIENT' | 'DELIVERY_REJECTED' | 'DELIVERY_UNCERTAIN' | 'SEND_INTENT_CONFLICT'
  | 'PERMISSION_DENIED' | 'UNKNOWN_PROVIDER_ERROR'

export class MailboxProviderError extends Error {
  constructor(public readonly code: MailboxErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MailboxProviderError'
  }
}

export function normalizeProviderError(error: unknown, status?: number): MailboxProviderError {
  if (error instanceof MailboxProviderError) return error
  const message = error instanceof Error ? error.message : 'Mailbox provider request failed'
  if (status === 401) return new MailboxProviderError('AUTH_EXPIRED', 'Mailbox authorization has expired')
  if (status === 403) return new MailboxProviderError('PERMISSION_DENIED', 'Mailbox permission was denied')
  if (status === 429) return new MailboxProviderError('RATE_LIMITED', 'Mailbox provider rate limit reached')
  if (status && status >= 500) return new MailboxProviderError('PROVIDER_UNAVAILABLE', 'Mailbox provider is unavailable')
  return new MailboxProviderError('UNKNOWN_PROVIDER_ERROR', message, { cause: error })
}
