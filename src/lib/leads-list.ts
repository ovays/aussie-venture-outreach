import { isDeliverySuppressedForAddress } from '@/lib/delivery-suppression'
import { normalizeSearchTerm } from '@/lib/search'

export const LEADS_PAGE_SIZE = 50
export const LEADS_MAX_PAGE_SIZE = 100
export const FILTERED_IDS_PAGE_SIZE = 1000
export const REGENERATION_BATCH_SIZE = 200
export const SUPPRESSED_LEADS_FILTER = 'suppressed'

export const LEADS_LIST_FIELDS = [
  'id',
  'business_name',
  'category_name',
  'city',
  'suburb',
  'email',
  'instagram_handle',
  'google_rating',
  'halal_confidence_score',
  'status',
  'created_at',
  'halal',
  'delivery_suppressed_emails',
  'outreach_suppression_reason',
  'outreach_suppressed_at',
] as const

export const LEADS_LIST_PROJECTION = LEADS_LIST_FIELDS.join(', ')

export interface LeadsFilterSnapshot {
  readonly search: string
  readonly status: string
  readonly stage: string
  readonly city: string
  readonly category: string
}

export interface LeadSuppressionFields {
  readonly email?: string | null
  readonly delivery_suppressed_emails?: string[] | null
  readonly outreach_suppression_reason?: string | null
  readonly outreach_suppressed_at?: string | null
}

const SUPPRESSION_REASON_LABELS: Readonly<Record<string, string>> = {
  email_already_contacted: 'Duplicate email',
  invalid_email: 'Invalid email',
  placeholder_email: 'Placeholder email',
  technical_email: 'Technical email',
}

export function isLeadSuppressed(lead: LeadSuppressionFields): boolean {
  return Boolean(
    lead.outreach_suppressed_at
    || lead.outreach_suppression_reason
    || isDeliverySuppressedForAddress(lead.email, lead.delivery_suppressed_emails),
  )
}

export function leadSuppressionLabel(lead: LeadSuppressionFields): string | null {
  const reason = lead.outreach_suppression_reason?.trim()
  if (reason) {
    return SUPPRESSION_REASON_LABELS[reason]
      ?? reason.replaceAll('_', ' ').replace(/^./, (character) => character.toUpperCase())
  }
  if (isDeliverySuppressedForAddress(lead.email, lead.delivery_suppressed_emails)) {
    return 'Delivery suppressed'
  }
  return lead.outreach_suppressed_at ? 'Suppressed' : null
}

export function normalizeLeadsSearch(search: string): string {
  return normalizeSearchTerm(search)
}

export function createLeadsFilterSnapshot(controls: {
  rawSearch: string
  status?: string
  stage?: string
  city?: string
  category?: string
}): LeadsFilterSnapshot {
  const status = controls.status?.trim() ?? ''
  return Object.freeze({
    search: normalizeLeadsSearch(controls.rawSearch),
    status,
    stage: status ? '' : controls.stage?.trim() ?? '',
    city: controls.city?.trim() ?? '',
    category: controls.category?.trim() ?? '',
  })
}

export function createLeadsFilterSearchParams(snapshot: LeadsFilterSnapshot): URLSearchParams {
  const params = new URLSearchParams()
  if (snapshot.search) params.set('search', snapshot.search)
  if (snapshot.stage) params.set('stage', snapshot.stage)
  else if (snapshot.status) params.set('status', snapshot.status)
  if (snapshot.city) params.set('city', snapshot.city)
  if (snapshot.category) params.set('category', snapshot.category)
  return params
}

export function createUniqueIdBatches(
  ids: readonly string[],
  batchSize = REGENERATION_BATCH_SIZE,
): string[][] {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError('batchSize must be a positive safe integer')
  }

  const uniqueIds = Array.from(new Set(ids))
  const batches: string[][] = []
  for (let offset = 0; offset < uniqueIds.length; offset += batchSize) {
    batches.push(uniqueIds.slice(offset, offset + batchSize))
  }
  return batches
}
