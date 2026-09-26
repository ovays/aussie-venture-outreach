// Stable machine-readable quota dimension keys. These are the single source of
// truth shared by the database CHECK constraints, the quota service, and the
// settings UI. Never scatter dimension names as ad-hoc strings in app code.

export const QUOTA_DIMENSIONS = [
  'outbound_email',
  'ai_request',
  'discovery_request',
  'workspace_member',
  'mailbox_connection',
  'stored_lead',
] as const

export type QuotaDimension = (typeof QUOTA_DIMENSIONS)[number]

// Period-usage dimensions are consumed atomically via counters.
export const CONSUMABLE_DIMENSIONS = [
  'outbound_email',
  'ai_request',
  'discovery_request',
] as const satisfies readonly QuotaDimension[]

// Count dimensions are derived from live records, not period counters.
export const COUNT_DIMENSIONS = [
  'workspace_member',
  'mailbox_connection',
  'stored_lead',
] as const satisfies readonly QuotaDimension[]

export function isQuotaDimension(value: string): value is QuotaDimension {
  return (QUOTA_DIMENSIONS as readonly string[]).includes(value)
}

export function isConsumableDimension(value: string): value is QuotaDimension {
  return isQuotaDimension(value) && (CONSUMABLE_DIMENSIONS as readonly string[]).includes(value)
}
