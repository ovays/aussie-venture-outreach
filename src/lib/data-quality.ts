import type { SupabaseClient } from '@supabase/supabase-js'

export const DATA_QUALITY_ISSUE_TYPES = [
  'duplicate_lead',
  'shared_email',
  'uncertain_email_group',
  'invalid_email',
  'placeholder_email',
  'technical_email',
  'already_contacted_email',
] as const

export type DataQualityIssueType = typeof DATA_QUALITY_ISSUE_TYPES[number]

export function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase()
  return normalized || null
}

const EMAIL_PATTERN = /^[^\s@<>(),;:\\"\[\]]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
const PLACEHOLDER_ADDRESSES = new Set([
  'user@domain.com',
  'john@doe.com',
  'test@example.com',
  'example@example.com',
  'user@example.com',
  'email@example.com',
  'name@example.com',
  'yourname@example.com',
  'test@test.com',
])
const PLACEHOLDER_DOMAINS = new Set(['example.com', 'example.org', 'example.net'])
const TECHNICAL_DOMAINS = [
  /(^|\.)ingest(?:\.[a-z0-9-]+)?\.sentry\.io$/i,
  /(^|\.)sentry\.io$/i,
  /(^|\.)sentry\.wixpress\.com$/i,
  /(^|\.)errors\.wix\.com$/i,
]

export type EmailQuality = {
  normalizedEmail: string | null
  issueType: 'invalid_email' | 'placeholder_email' | 'technical_email' | null
  reason: string | null
}

export function classifyEmailQuality(email: string | null | undefined): EmailQuality {
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || !EMAIL_PATTERN.test(normalizedEmail)) {
    return { normalizedEmail, issueType: 'invalid_email', reason: 'Email is empty or malformed.' }
  }

  const at = normalizedEmail.lastIndexOf('@')
  const local = normalizedEmail.slice(0, at)
  const domain = normalizedEmail.slice(at + 1)
  if (PLACEHOLDER_ADDRESSES.has(normalizedEmail) || PLACEHOLDER_DOMAINS.has(domain)) {
    return { normalizedEmail, issueType: 'placeholder_email', reason: 'Address uses a standard example, test, or placeholder mailbox.' }
  }

  const machineLocal = /^(?:[a-f0-9]{24,}|sentry(?:[-_.].*)?|errors?(?:[-_.].*)?|[a-z0-9_-]+\+[a-f0-9]{16,})$/i.test(local)
  if (TECHNICAL_DOMAINS.some((pattern) => pattern.test(domain)) && machineLocal) {
    return { normalizedEmail, issueType: 'technical_email', reason: 'Address is a provider-generated error-reporting or ingestion mailbox.' }
  }

  return { normalizedEmail, issueType: null, reason: null }
}

export type DuplicateSignalLead = {
  id: string
  business_name: string | null
  website?: string | null
  phone?: string | null
  address?: string | null
  suburb?: string | null
  instagram_handle?: string | null
}

function compact(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function websiteDomain(value: string | null | undefined): string {
  if (!value) return ''
  try {
    return new URL(value.match(/^https?:\/\//i) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return value.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '')
  }
}

export function classifyDuplicateGroup(leads: DuplicateSignalLead[]): {
  issueType: 'duplicate_lead' | 'shared_email' | 'uncertain_email_group'
  reasons: string[]
} {
  if (leads.length < 2) return { issueType: 'uncertain_email_group', reasons: ['Only one lead was supplied.'] }
  const names = leads.map((lead) => compact(lead.business_name)).filter(Boolean)
  const domains = leads.map((lead) => websiteDomain(lead.website)).filter(Boolean)
  const phones = leads.map((lead) => compact(lead.phone)).filter(Boolean)
  const socials = leads.map((lead) => compact(lead.instagram_handle)).filter(Boolean)
  const addresses = leads.map((lead) => compact(`${lead.address ?? ''}${lead.suburb ?? ''}`)).filter(Boolean)
  const allSame = (values: string[]) => values.length === leads.length && new Set(values).size === 1

  const strong: string[] = []
  if (allSame(names)) strong.push('same_normalized_business_name')
  if (allSame(domains)) strong.push('same_website_domain')
  if (allSame(phones)) strong.push('same_phone')
  if (allSame(socials)) strong.push('same_social_handle')
  if (strong.length >= 2 || strong.includes('same_normalized_business_name')) {
    return { issueType: 'duplicate_lead', reasons: ['same_normalized_email', ...strong] }
  }

  if (new Set(names).size === leads.length && (addresses.length === 0 || new Set(addresses).size > 1)) {
    return { issueType: 'shared_email', reasons: ['same_normalized_email', 'different_business_names', ...(new Set(addresses).size > 1 ? ['different_addresses'] : [])] }
  }
  return { issueType: 'uncertain_email_group', reasons: ['same_normalized_email', 'insufficient_deterministic_signals'] }
}

export type CleanupCandidate = DuplicateSignalLead & {
  status?: string | null
  outreachCount?: number
  hasReply?: boolean
  hasDeal?: boolean
  hasBooking?: boolean
  hasNotes?: boolean
  hasEmailHistory?: boolean
  createdAt?: string | null
}

const LIFECYCLE_RANK: Record<string, number> = {
  closed_won: 70, closed: 65, negotiating: 60, interested: 55, replied: 50,
  contacted: 30, email_ready: 20, researched: 10, new: 0, dead: -10,
}

export function isProtectedFromAutoDelete(lead: CleanupCandidate): boolean {
  return Boolean(lead.hasReply || lead.hasDeal || lead.hasBooking || lead.hasNotes || lead.hasEmailHistory || (lead.outreachCount ?? 0) > 0 || ['replied', 'negotiating', 'interested', 'closed', 'closed_won'].includes(lead.status ?? ''))
}

export function choosePreferredLead(leads: CleanupCandidate[]): CleanupCandidate | null {
  return [...leads].sort((a, b) => {
    const protectedDiff = Number(isProtectedFromAutoDelete(b)) - Number(isProtectedFromAutoDelete(a))
    if (protectedDiff) return protectedDiff
    const lifecycleDiff = (LIFECYCLE_RANK[b.status ?? ''] ?? 0) - (LIFECYCLE_RANK[a.status ?? ''] ?? 0)
    if (lifecycleDiff) return lifecycleDiff
    const historyDiff = (b.outreachCount ?? 0) - (a.outreachCount ?? 0)
    if (historyDiff) return historyDiff
    const completeness = (lead: CleanupCandidate) => [lead.business_name, lead.website, lead.phone, lead.address, lead.suburb, lead.instagram_handle].filter(Boolean).length
    const completenessDiff = completeness(b) - completeness(a)
    if (completenessDiff) return completenessDiff
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id)
  })[0] ?? null
}

export type RecipientOwnershipDecision = {
  allowed: boolean
  ownerLeadId: string | null
  normalizedEmail: string | null
  reason: string | null
}

export async function claimRecipientOutreach(
  supabase: SupabaseClient,
  leadId: string,
  phase: 'initial' | 'follow_up' | 'reactivation',
): Promise<RecipientOwnershipDecision> {
  const { data, error } = await supabase.rpc('claim_recipient_outreach', {
    p_lead_id: leadId,
    p_phase: phase,
  })
  if (error) throw new Error(`Recipient outreach ownership check failed: ${error.message}`)
  const result = (data ?? {}) as Record<string, unknown>
  return {
    allowed: result.allowed === true,
    ownerLeadId: typeof result.owner_lead_id === 'string' ? result.owner_lead_id : null,
    normalizedEmail: typeof result.normalized_email === 'string' ? result.normalized_email : null,
    reason: typeof result.reason === 'string' ? result.reason : null,
  }
}

export async function refreshLeadDataQuality(supabase: SupabaseClient, leadId: string): Promise<void> {
  const { error } = await supabase.rpc('refresh_lead_data_quality', { p_lead_id: leadId })
  if (error) throw new Error(`Lead data-quality refresh failed: ${error.message}`)
}
