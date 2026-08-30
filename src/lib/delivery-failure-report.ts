import { resolvePagination } from '@/lib/pagination'

export const DELIVERY_FAILURE_STATUSES = ['bounced', 'failed', 'suppressed'] as const
export const DELIVERY_FAILURE_EMAIL_TYPES = ['initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'reactivation'] as const

export type DeliveryFailureStatus = (typeof DELIVERY_FAILURE_STATUSES)[number]
export type DeliveryFailureEmailType = (typeof DELIVERY_FAILURE_EMAIL_TYPES)[number]
export type DeliveryFailureSource = 'provider' | 'local_api'

export interface DeliveryFailureFilters {
  status: DeliveryFailureStatus | null
  emailType: DeliveryFailureEmailType | null
  search: string
  page: number
  pageSize: number
}

export interface DeliveryFailureRecord {
  email_id: string
  lead_id: string | null
  business_name: string | null
  email_address: string | null
  category: string | null
  city: string | null
  failure_status: DeliveryFailureStatus
  email_type: DeliveryFailureEmailType
  failure_date: string
  resend_id: string | null
  failure_source: DeliveryFailureSource
  provider: 'Resend' | 'Local/API'
  failure_reason: string
}

export interface DeliveryFailureSummary {
  total: number
  bounced: number
  failed: number
  suppressed: number
}

interface SearchParamsLike {
  get(name: string): string | null
}

interface DeliveryFailureRpcRow {
  email_id?: unknown
  lead_id?: unknown
  business_name?: unknown
  recipient?: unknown
  category_name?: unknown
  city?: unknown
  failure_status?: unknown
  email_type?: unknown
  failure_date?: unknown
  resend_id?: unknown
  has_provider_event?: unknown
  failure_metadata?: unknown
}

function includedValue<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return allowed.includes(value as T) ? value as T : null
}

export function parseDeliveryFailureFilters(searchParams: SearchParamsLike): DeliveryFailureFilters {
  const pagination = resolvePagination({
    page: searchParams.get('page'),
    pageSize: searchParams.get('page_size'),
  })

  return {
    status: includedValue(searchParams.get('status'), DELIVERY_FAILURE_STATUSES),
    emailType: includedValue(searchParams.get('type'), DELIVERY_FAILURE_EMAIL_TYPES),
    search: (searchParams.get('search') ?? '').trim().slice(0, 200),
    page: pagination.page,
    pageSize: pagination.pageSize,
  }
}

function readableScalar(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function findReason(value: unknown, depth = 0): string | null {
  if (depth > 5 || value == null) return null

  const scalar = readableScalar(value)
  if (scalar) return scalar

  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = findReason(item, depth + 1)
      if (reason) return reason
    }
    return null
  }

  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const preferredKeys = ['provider_reason', 'reason', 'message', 'error', 'response', 'detail', 'description']
  for (const key of preferredKeys) {
    if (!(key in record)) continue
    const reason = findReason(record[key], depth + 1)
    if (reason) return reason
  }

  for (const nested of Object.values(record)) {
    const reason = findReason(nested, depth + 1)
    if (reason) return reason
  }
  return null
}

export function extractDeliveryFailureReason(metadata: unknown, source: DeliveryFailureSource): string {
  const reason = findReason(metadata)
  if (!reason) return source === 'provider' ? 'No provider reason recorded' : 'No local/API reason recorded'
  return reason.length > 300 ? `${reason.slice(0, 297)}...` : reason
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function mapDeliveryFailureRow(row: DeliveryFailureRpcRow): DeliveryFailureRecord {
  const status = includedValue(nullableString(row.failure_status), DELIVERY_FAILURE_STATUSES) ?? 'failed'
  const emailType = includedValue(nullableString(row.email_type), DELIVERY_FAILURE_EMAIL_TYPES) ?? 'initial_pitch'
  const source: DeliveryFailureSource = status === 'failed' && row.has_provider_event !== true ? 'local_api' : 'provider'

  return {
    email_id: nullableString(row.email_id) ?? '',
    lead_id: nullableString(row.lead_id),
    business_name: nullableString(row.business_name),
    email_address: nullableString(row.recipient),
    category: nullableString(row.category_name),
    city: nullableString(row.city),
    failure_status: status,
    email_type: emailType,
    failure_date: nullableString(row.failure_date) ?? new Date(0).toISOString(),
    resend_id: nullableString(row.resend_id),
    failure_source: source,
    provider: source === 'provider' ? 'Resend' : 'Local/API',
    failure_reason: extractDeliveryFailureReason(row.failure_metadata, source),
  }
}

export function normalizeDeliveryFailureSummary(value: unknown): DeliveryFailureSummary {
  const summary = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const count = (key: string) => typeof summary[key] === 'number' ? summary[key] as number : Number(summary[key] ?? 0) || 0
  return { total: count('total'), bounced: count('bounced'), failed: count('failed'), suppressed: count('suppressed') }
}
