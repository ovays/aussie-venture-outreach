import { normalizeEmail } from '@/lib/data-quality'

export const TERMINAL_DELIVERY_STATUSES = ['bounced', 'failed', 'suppressed'] as const
export type TerminalDeliveryStatus = (typeof TERMINAL_DELIVERY_STATUSES)[number]

export const TERMINAL_RESEND_EVENTS = {
  'email.bounced': 'bounced',
  'email.failed': 'failed',
  'email.suppressed': 'suppressed',
} as const satisfies Record<string, TerminalDeliveryStatus>

export type TerminalResendEvent = keyof typeof TERMINAL_RESEND_EVENTS

export function isTerminalDeliveryStatus(status: string | null | undefined): status is TerminalDeliveryStatus {
  return TERMINAL_DELIVERY_STATUSES.includes(status as TerminalDeliveryStatus)
}

export function normalizeDeliveryEmail(value: string | null | undefined): string | null {
  if (!value) return null
  const angleAddress = value.match(/<([^<>]+)>/)?.[1]
  return normalizeEmail(angleAddress ?? value)
}

export function isDeliverySuppressedForAddress(
  address: string | null | undefined,
  suppressedAddresses: string[] | null | undefined,
): boolean {
  const normalized = normalizeDeliveryEmail(address)
  if (!normalized) return false
  return (suppressedAddresses ?? []).some((candidate) => normalizeDeliveryEmail(candidate) === normalized)
}
