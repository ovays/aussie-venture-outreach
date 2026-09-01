/** Read-only audit for the current database. It performs paged bulk reads and no mutations. */
import { config } from 'dotenv'
import path from 'node:path'
import { createServiceClient } from '../src/lib/supabase/server'
import {
  choosePreferredLead,
  classifyDuplicateGroup,
  classifyEmailQuality,
  isProtectedFromAutoDelete,
  normalizeEmail,
  type CleanupCandidate,
} from '../src/lib/data-quality'

config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true })

type LeadRow = {
  id: string; business_name: string; email: string | null; website: string | null; phone: string | null
  address: string | null; suburb: string | null; instagram_handle: string | null; status: string | null
  notes: string | null; created_at: string | null
}
type EmailRow = { id: string; lead_id: string; status: string; replied_at: string | null }
type DealRow = { lead_id: string }

function legacyCompact(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function legacyWebsiteDomain(value: string | null | undefined): string {
  if (!value) return ''
  try {
    return new URL(value.match(/^https?:\/\//i) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return value.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '')
  }
}

function classifyCurrentGroup(leads: LeadRow[]): ReturnType<typeof classifyDuplicateGroup> {
  const names = leads.map((lead) => legacyCompact(lead.business_name)).filter(Boolean)
  const domains = leads.map((lead) => legacyWebsiteDomain(lead.website)).filter(Boolean)
  const phones = leads.map((lead) => legacyCompact(lead.phone)).filter(Boolean)
  const socials = leads.map((lead) => legacyCompact(lead.instagram_handle)).filter(Boolean)
  const addresses = leads.map((lead) => legacyCompact(`${lead.address ?? ''}${lead.suburb ?? ''}`)).filter(Boolean)
  const distinctCount = (values: string[]) => new Set(values).size
  if (distinctCount(names) === 1) {
    return { issueType: 'duplicate_lead', reasons: ['same_normalized_email', 'same_normalized_business_name'] }
  }
  if (distinctCount(domains) === 1 && distinctCount(phones) === 1) {
    return { issueType: 'duplicate_lead', reasons: ['same_normalized_email', 'same_website_domain', 'same_phone'] }
  }
  if (distinctCount(domains) === 1 && distinctCount(socials) === 1) {
    return { issueType: 'duplicate_lead', reasons: ['same_normalized_email', 'same_website_domain', 'same_social_handle'] }
  }
  if (distinctCount(names) === leads.length && (distinctCount(addresses) === 0 || distinctCount(addresses) > 1)) {
    return { issueType: 'shared_email', reasons: ['same_normalized_email', 'different_business_names'] }
  }
  return { issueType: 'uncertain_email_group', reasons: ['same_normalized_email', 'insufficient_deterministic_signals'] }
}

async function readAll<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await fetchPage(from, from + 999)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []))
    if ((data?.length ?? 0) < 1000) return rows
  }
}

async function main() {
  const db = createServiceClient()
  const [leads, emails, deals] = await Promise.all([
    readAll<LeadRow>((from, to) => db.from('leads').select('id,business_name,email,website,phone,address,suburb,instagram_handle,status,notes,created_at').order('id').range(from, to)),
    readAll<EmailRow>((from, to) => db.from('emails').select('id,lead_id,status,replied_at').order('id').range(from, to)),
    readAll<DealRow>((from, to) => db.from('deals').select('lead_id').order('lead_id').range(from, to)),
  ])
  const emailHistory = new Map<string, EmailRow[]>()
  for (const email of emails) emailHistory.set(email.lead_id, [...(emailHistory.get(email.lead_id) ?? []), email])
  const dealLeads = new Set(deals.map((deal) => deal.lead_id))
  const groups = new Map<string, LeadRow[]>()
  const quality = { invalid_email: 0, placeholder_email: 0, technical_email: 0 }
  for (const lead of leads) {
    const result = classifyEmailQuality(lead.email)
    if (result.issueType) quality[result.issueType]++
    const normalized = normalizeEmail(lead.email)
    if (normalized) groups.set(normalized, [...(groups.get(normalized) ?? []), lead])
  }
  const currentCounts = { duplicate_lead: 0, shared_email: 0, uncertain_email_group: 0 }
  const revisedCounts = { duplicate_lead: 0, shared_email: 0, uncertain_email_group: 0 }
  const changedExamples: Array<Record<string, unknown>> = []
  let alreadyContactedEmailLeads = 0, protectedDuplicateRecords = 0, safeLookingDuplicateCandidates = 0
  for (const [normalizedEmail, group] of groups) {
    if (group.length < 2) continue
    const current = classifyCurrentGroup(group)
    const classification = classifyDuplicateGroup(group)
    currentCounts[current.issueType]++
    revisedCounts[classification.issueType]++
    if (current.issueType !== classification.issueType && changedExamples.length < 20) {
      changedExamples.push({
        normalized_email: normalizedEmail,
        business_names: group.map((lead) => lead.business_name),
        current: current.issueType,
        revised: classification.issueType,
        revised_reasons: classification.reasons,
      })
    }
    const candidates: CleanupCandidate[] = group.map((lead) => {
      const history = emailHistory.get(lead.id) ?? []
      return {
        ...lead, createdAt: lead.created_at, hasReply: history.some((row) => row.replied_at),
        hasDeal: dealLeads.has(lead.id), hasNotes: Boolean(lead.notes?.trim()), hasEmailHistory: history.length > 0,
        outreachCount: history.filter((row) => row.status === 'sent' || row.status === 'email_sync_failed').length,
      }
    })
    const owner = choosePreferredLead(candidates.filter((lead) => (lead.outreachCount ?? 0) > 0))
    if (owner) alreadyContactedEmailLeads += candidates.filter((lead) => lead.id !== owner.id).length
    if (classification.issueType === 'duplicate_lead') {
      protectedDuplicateRecords += candidates.filter(isProtectedFromAutoDelete).length
      const preferred = choosePreferredLead(candidates)
      safeLookingDuplicateCandidates += candidates.filter((lead) => lead.id !== preferred?.id && !isProtectedFromAutoDelete(lead)).length
    }
  }
  console.log(JSON.stringify({
    leads_scanned: leads.length,
    shadow_comparison: {
      current: {
        duplicate_lead_groups: currentCounts.duplicate_lead,
        shared_email_groups: currentCounts.shared_email,
        uncertain_email_groups: currentCounts.uncertain_email_group,
      },
      revised: {
        duplicate_lead_groups: revisedCounts.duplicate_lead,
        shared_email_groups: revisedCounts.shared_email,
        uncertain_email_groups: revisedCounts.uncertain_email_group,
      },
      changed_examples: changedExamples,
    },
    placeholder_emails: quality.placeholder_email,
    technical_emails: quality.technical_email,
    invalid_emails: quality.invalid_email,
    already_contacted_email_leads: alreadyContactedEmailLeads,
    protected_duplicate_records: protectedDuplicateRecords,
    safe_looking_duplicate_candidates: safeLookingDuplicateCandidates,
    mutations: 0,
  }, null, 2))
}

main().catch((error) => { console.error(error); process.exit(1) })
