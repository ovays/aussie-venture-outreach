import type { SupabaseClient } from '@supabase/supabase-js'
import { isProtectedFromAutoDelete } from '@/lib/data-quality'

export interface DataQualityLeadDetail {
  id: string
  business_name: string
  email: string | null
  status: string
  city: string | null
  suburb: string | null
  category: string | null
  website: string | null
  phone: string | null
  instagram: string | null
  facebook: string | null
  address: string | null
  state: string | null
  notes: string | null
  created_at: string | null
  updated_at: string | null
  outreach_count: number
  email_history_count: number
  reply_count: number
  latest_replied_at: string | null
  latest_reply_activity_at: string | null
  reply_lifecycle_state: 'verified_reply' | 'lifecycle_only' | 'none'
  latest_outreach: string | null
  has_reply: boolean
  has_deal: boolean
  deal_count: number
  deals: Array<{
    id: string
    deal_value: number | null
    deal_type: string | null
    closed_at: string | null
    created_at: string | null
    notes: string | null
  }>
  has_notes: boolean
  has_email_history: boolean
  protected_from_auto_delete: boolean
  protection_reasons: string[]
  is_outreach_owner: boolean
  outreach_blocked: boolean
}

export interface DataQualityOwnership {
  normalized_email: string
  owner_lead_id: string | null
  owner_business_name: string | null
  state: string
  last_activity_at: string | null
}

export type DataQualityReportRow = Record<string, unknown> & {
  issue_type: string
  normalized_email: string | null
  lead_ids: string[]
  leads?: DataQualityLeadDetail[]
  ownership?: DataQualityOwnership | null
}

function protectionReasons(input: {
  status: string
  hasReply: boolean
  hasDeal: boolean
  hasNotes: boolean
  hasEmailHistory: boolean
}): string[] {
  const reasons: string[] = []
  if (input.hasEmailHistory) reasons.push('Has email history')
  if (input.hasReply) reasons.push('Has reply')
  if (input.hasDeal) reasons.push('Has deal')
  if (input.hasNotes) reasons.push('Has notes')
  if (['replied', 'negotiating', 'interested', 'closed', 'closed_won', 'closed_manual'].includes(input.status)) {
    reasons.push('Active/positive lifecycle')
  }
  return reasons
}

export async function enrichDataQualityRows(
  supabase: SupabaseClient,
  rows: DataQualityReportRow[],
): Promise<DataQualityReportRow[]> {
  const leadIds = [...new Set(rows.flatMap((row) => row.lead_ids ?? []))]
  const normalizedEmails = [...new Set(rows.map((row) => row.normalized_email).filter((email): email is string => !!email))]
  if (leadIds.length === 0) return rows.map((row) => ({ ...row, leads: [], ownership: null }))

  const [leadResult, emailResult, dealResult, ownershipResult, replyActivityResult] = await Promise.all([
    supabase.from('leads').select('id,business_name,email,status,city,suburb,state,address,category_name,website,phone,instagram_handle,facebook_url,created_at,updated_at,notes').in('id', leadIds),
    supabase.from('emails').select('id,lead_id,status,sent_at,replied_at,created_at').in('lead_id', leadIds),
    supabase.from('deals').select('id,lead_id,deal_value,deal_type,closed_at,created_at,notes').in('lead_id', leadIds),
    normalizedEmails.length > 0
      ? supabase.from('recipient_outreach_ownership').select('normalized_email,owner_lead_id,state,last_activity_at').in('normalized_email', normalizedEmails)
      : Promise.resolve({ data: [], error: null }),
    supabase.from('activity_log').select('id,lead_id,created_at').in('lead_id', leadIds).eq('event_type', 'reply_received'),
  ])

  const firstError = leadResult.error ?? emailResult.error ?? dealResult.error ?? ownershipResult.error ?? replyActivityResult.error
  if (firstError) throw new Error(firstError.message)

  const ownershipRows = (ownershipResult.data ?? []) as Array<Record<string, unknown>>
  const missingOwnerIds = [...new Set(ownershipRows
    .map((ownership) => typeof ownership.owner_lead_id === 'string' ? ownership.owner_lead_id : null)
    .filter((id): id is string => !!id && !leadIds.includes(id)))]
  const ownerResult = missingOwnerIds.length > 0
    ? await supabase.from('leads').select('id,business_name').in('id', missingOwnerIds)
    : { data: [], error: null }
  if (ownerResult.error) throw new Error(ownerResult.error.message)

  const leads = (leadResult.data ?? []) as Array<Record<string, unknown>>
  const ownerNames = new Map<string, string>()
  for (const lead of [...leads, ...((ownerResult.data ?? []) as Array<Record<string, unknown>>)]) {
    if (typeof lead.id === 'string') ownerNames.set(lead.id, String(lead.business_name ?? 'Unknown business'))
  }
  const emailsByLead = new Map<string, Array<Record<string, unknown>>>()
  for (const email of (emailResult.data ?? []) as Array<Record<string, unknown>>) {
    const id = String(email.lead_id)
    emailsByLead.set(id, [...(emailsByLead.get(id) ?? []), email])
  }
  const dealsByLead = new Map<string, Array<Record<string, unknown>>>()
  for (const deal of (dealResult.data ?? []) as Array<Record<string, unknown>>) {
    const id = String(deal.lead_id)
    dealsByLead.set(id, [...(dealsByLead.get(id) ?? []), deal])
  }
  const replyActivityByLead = new Map<string, string[]>()
  for (const activity of (replyActivityResult.data ?? []) as Array<Record<string, unknown>>) {
    const id = String(activity.lead_id)
    const at = typeof activity.created_at === 'string' ? activity.created_at : null
    if (at) replyActivityByLead.set(id, [...(replyActivityByLead.get(id) ?? []), at])
  }
  const ownershipByEmail = new Map<string, DataQualityOwnership>()
  for (const ownership of ownershipRows) {
    const normalizedEmail = String(ownership.normalized_email)
    const ownerLeadId = typeof ownership.owner_lead_id === 'string' ? ownership.owner_lead_id : null
    ownershipByEmail.set(normalizedEmail, {
      normalized_email: normalizedEmail,
      owner_lead_id: ownerLeadId,
      owner_business_name: ownerLeadId ? ownerNames.get(ownerLeadId) ?? null : null,
      state: String(ownership.state ?? 'active'),
      last_activity_at: typeof ownership.last_activity_at === 'string' ? ownership.last_activity_at : null,
    })
  }

  const detailsById = new Map<string, DataQualityLeadDetail>()
  for (const lead of leads) {
    const id = String(lead.id)
    const emails = emailsByLead.get(id) ?? []
    const deals = dealsByLead.get(id) ?? []
    const sent = emails.filter((email) => ['sent', 'email_sync_failed'].includes(String(email.status)))
    const latestOutreach = sent
      .map((email) => String(email.sent_at ?? email.created_at ?? ''))
      .filter(Boolean)
      .sort()
      .at(-1) ?? null
    const status = String(lead.status ?? 'new')
    const repliedDates = emails.map((email) => typeof email.replied_at === 'string' ? email.replied_at : null).filter((date): date is string => !!date).sort()
    const hasVerifiedReply = repliedDates.length > 0
    const hasReply = hasVerifiedReply || ['replied', 'negotiating', 'interested', 'closed', 'closed_won', 'closed_manual'].includes(status)
    const hasDeal = deals.length > 0 || ['closed', 'closed_won', 'closed_manual'].includes(status)
    const hasNotes = typeof lead.notes === 'string' && lead.notes.trim().length > 0
    const hasEmailHistory = emails.length > 0
    const reasons = protectionReasons({ status, hasReply, hasDeal, hasNotes, hasEmailHistory })
    const normalizedEmail = typeof lead.email === 'string' ? lead.email.trim().toLowerCase() : null
    const ownership = normalizedEmail ? ownershipByEmail.get(normalizedEmail) : null
    const isOwner = ownership?.state === 'active' && ownership.owner_lead_id === id
    detailsById.set(id, {
      id,
      business_name: String(lead.business_name ?? 'Unknown business'),
      email: typeof lead.email === 'string' ? lead.email : null,
      status,
      city: typeof lead.city === 'string' ? lead.city : null,
      suburb: typeof lead.suburb === 'string' ? lead.suburb : null,
      category: typeof lead.category_name === 'string' ? lead.category_name : null,
      website: typeof lead.website === 'string' ? lead.website : null,
      phone: typeof lead.phone === 'string' ? lead.phone : null,
      instagram: typeof lead.instagram_handle === 'string' ? lead.instagram_handle : null,
      facebook: typeof lead.facebook_url === 'string' ? lead.facebook_url : null,
      address: typeof lead.address === 'string' ? lead.address : null,
      state: typeof lead.state === 'string' ? lead.state : null,
      notes: typeof lead.notes === 'string' ? lead.notes : null,
      created_at: typeof lead.created_at === 'string' ? lead.created_at : null,
      updated_at: typeof lead.updated_at === 'string' ? lead.updated_at : null,
      outreach_count: sent.length,
      email_history_count: emails.length,
      reply_count: repliedDates.length,
      latest_replied_at: repliedDates.at(-1) ?? null,
      latest_reply_activity_at: (replyActivityByLead.get(id) ?? []).sort().at(-1) ?? null,
      reply_lifecycle_state: hasVerifiedReply ? 'verified_reply' : hasReply ? 'lifecycle_only' : 'none',
      latest_outreach: latestOutreach,
      has_reply: hasReply,
      has_deal: hasDeal,
      deal_count: deals.length,
      deals: deals.map((deal) => ({
        id: String(deal.id),
        deal_value: typeof deal.deal_value === 'number' ? deal.deal_value : deal.deal_value == null ? null : Number(deal.deal_value),
        deal_type: typeof deal.deal_type === 'string' ? deal.deal_type : null,
        closed_at: typeof deal.closed_at === 'string' ? deal.closed_at : null,
        created_at: typeof deal.created_at === 'string' ? deal.created_at : null,
        notes: typeof deal.notes === 'string' ? deal.notes : null,
      })),
      has_notes: hasNotes,
      has_email_history: hasEmailHistory,
      protected_from_auto_delete: isProtectedFromAutoDelete({
        id, business_name: String(lead.business_name ?? ''), status,
        hasReply, hasDeal, hasNotes, hasEmailHistory, outreachCount: sent.length,
      }),
      protection_reasons: reasons,
      is_outreach_owner: isOwner,
      outreach_blocked: Boolean(ownership?.owner_lead_id && !isOwner),
    })
  }

  return rows.map((row) => ({
    ...row,
    leads: (row.lead_ids ?? []).map((id) => detailsById.get(id)).filter((lead): lead is DataQualityLeadDetail => !!lead),
    ownership: row.normalized_email ? ownershipByEmail.get(row.normalized_email) ?? null : null,
  }))
}
