import { createServiceClient } from '@/lib/supabase/server'

export const PIPELINE_DEDUPE_STATUSES = [
  'new',
  'researched',
  'email_ready',
  'contacted',
  'followup_pending',
  'followup_sent',
] as const

export type PipelineDedupeStatus = typeof PIPELINE_DEDUPE_STATUSES[number]

export type DedupeLead = {
  id: string
  business_name: string | null
  email: string | null
  status: string | null
  created_at?: string | null
}

export type DedupeMatch = {
  id: string
  businessName: string | null
  email: string
  status: string | null
  createdAt?: string | null
}

export type DedupeDecision =
  | { duplicate: false; email: string; rootDomain: string | null }
  | {
      duplicate: true
      reason: 'DUPLICATE_EMAIL_SKIPPED' | 'DUPLICATE_DOMAIN_SKIPPED'
      email: string
      rootDomain: string | null
      match: DedupeMatch
    }

export type LeadDedupeIndex = {
  byEmail: Map<string, DedupeMatch[]>
  byRootDomain: Map<string, DedupeMatch[]>
}

// Personal/shared email providers must never be used for domain-based dedup.
// e.g. info@gmail.com and contact@gmail.com are unrelated businesses.
export const PERSONAL_EMAIL_PROVIDER_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.com.au',
  'outlook.com',
  'live.com',
  'live.com.au',
  'yahoo.com',
  'yahoo.com.au',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'bigpond.com',
  'bigpond.net.au',
  'optusnet.com.au',
  'tpg.com.au',
  'internode.on.net',
])

const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'asn.au',
  'id.au',
  'co.nz',
  'org.nz',
  'net.nz',
  'co.uk',
  'org.uk',
  'ac.uk',
])

export function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase()
  if (!normalized || !normalized.includes('@')) return null
  return normalized
}

export function extractRootDomainFromEmail(email: string | null | undefined): string | null {
  const normalized = normalizeEmail(email)
  const domain = normalized?.split('@')[1]?.replace(/\.+$/, '')
  if (!domain) return null

  const parts = domain.split('.').filter(Boolean)
  if (parts.length < 2) return null

  const suffix = parts.slice(-2).join('.')
  if (parts.length >= 3 && MULTI_PART_PUBLIC_SUFFIXES.has(suffix)) {
    return parts.slice(-3).join('.')
  }

  return parts.slice(-2).join('.')
}

export function createLeadDedupeIndex(leads: DedupeLead[]): LeadDedupeIndex {
  const byEmail = new Map<string, DedupeMatch[]>()
  const byRootDomain = new Map<string, DedupeMatch[]>()

  for (const lead of leads) {
    const email = normalizeEmail(lead.email)
    if (!email) continue

    const match: DedupeMatch = {
      id: lead.id,
      businessName: lead.business_name,
      email,
      status: lead.status,
      createdAt: lead.created_at,
    }

    const emailMatches = byEmail.get(email) ?? []
    emailMatches.push(match)
    byEmail.set(email, emailMatches)

    const rootDomain = extractRootDomainFromEmail(email)
    if (!rootDomain || PERSONAL_EMAIL_PROVIDER_DOMAINS.has(rootDomain)) continue

    const domainMatches = byRootDomain.get(rootDomain) ?? []
    domainMatches.push(match)
    byRootDomain.set(rootDomain, domainMatches)
  }

  return { byEmail, byRootDomain }
}

export function addLeadToDedupeIndex(index: LeadDedupeIndex, lead: DedupeLead): void {
  const next = createLeadDedupeIndex([lead])
  for (const [email, matches] of next.byEmail) {
    index.byEmail.set(email, [...(index.byEmail.get(email) ?? []), ...matches])
  }
  for (const [domain, matches] of next.byRootDomain) {
    index.byRootDomain.set(domain, [...(index.byRootDomain.get(domain) ?? []), ...matches])
  }
}

export function checkLeadDedupe(
  emailInput: string | null | undefined,
  index: LeadDedupeIndex,
  currentLeadId?: string
): DedupeDecision {
  const email = normalizeEmail(emailInput)
  const rootDomain = extractRootDomainFromEmail(email)

  if (!email) return { duplicate: false, email: '', rootDomain }

  const emailMatch = getCanonicalDuplicate(index.byEmail.get(email) ?? [], currentLeadId)
  if (emailMatch) {
    return {
      duplicate: true,
      reason: 'DUPLICATE_EMAIL_SKIPPED',
      email,
      rootDomain,
      match: emailMatch,
    }
  }

  if (rootDomain && !PERSONAL_EMAIL_PROVIDER_DOMAINS.has(rootDomain)) {
    const domainMatch = getCanonicalDuplicate(index.byRootDomain.get(rootDomain) ?? [], currentLeadId)
    if (domainMatch) {
      return {
        duplicate: true,
        reason: 'DUPLICATE_DOMAIN_SKIPPED',
        email,
        rootDomain,
        match: domainMatch,
      }
    }
  }

  return { duplicate: false, email, rootDomain }
}

function getCanonicalDuplicate(matches: DedupeMatch[], currentLeadId?: string): DedupeMatch | undefined {
  if (!matches.length) return undefined
  if (!currentLeadId) return matches[0]

  const currentIndex = matches.findIndex((match) => match.id === currentLeadId)
  if (currentIndex === 0) return undefined
  if (currentIndex > 0) return matches[0]

  return matches.find((match) => match.id !== currentLeadId)
}

export async function fetchPipelineDedupeIndex(
  supabase: ReturnType<typeof createServiceClient>
): Promise<LeadDedupeIndex> {
  const { data, error } = await supabase
    .from('leads')
    .select('id, business_name, email, status, created_at')
    .in('status', [...PIPELINE_DEDUPE_STATUSES])
    .not('email', 'is', null)
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Failed to load pipeline dedupe index: ${error.message}`)
  return createLeadDedupeIndex((data ?? []) as DedupeLead[])
}
