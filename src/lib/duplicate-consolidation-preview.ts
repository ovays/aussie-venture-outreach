import 'server-only'

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildDuplicateConsolidationPreview,
  type ConsolidationDealSnapshot,
  type ConsolidationEmailSnapshot,
  type ConsolidationFollowupSnapshot,
  type ConsolidationLeadSnapshot,
  type ConsolidationLinkedRowSnapshot,
  type ConsolidationOwnershipSnapshot,
  type ConsolidationSnapshot,
  type DuplicateConsolidationPreviewInput,
} from '@/lib/duplicate-consolidation'

function rows<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function stableRows(value: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...value].sort((a, b) => String(a.id ?? a.normalized_email ?? '').localeCompare(String(b.id ?? b.normalized_email ?? '')))
}

export async function createDuplicateConsolidationPreview(
  supabase: SupabaseClient,
  input: DuplicateConsolidationPreviewInput,
) {
  const groupResult = await supabase
    .from('leads')
    .select('id,business_name,normalized_email,status,updated_at,website,phone,address,suburb,instagram_handle,facebook_url,notes,category_name,city,deal_value,deal_type')
    .eq('normalized_email', input.normalized_email)

  if (groupResult.error) throw new Error(groupResult.error.message)
  const groupLeads = rows<ConsolidationLeadSnapshot>(groupResult.data)
  const groupIds = groupLeads.map((lead) => lead.id)

  const empty = Promise.resolve({ data: [], error: null })
  const [emailResult, dealResult, followupResult, dmResult, activityResult, flagResult, ownershipResult] = await Promise.all([
    groupIds.length ? supabase.from('emails').select('id,lead_id,type,status,sent_at,replied_at,created_at,resend_id,message_id').in('lead_id', groupIds) : empty,
    groupIds.length ? supabase.from('deals').select('id,lead_id,deal_value,deal_type,closed_at,created_at,notes').in('lead_id', groupIds) : empty,
    groupIds.length ? supabase.from('follow_ups').select('id,lead_id,follow_up_number,scheduled_at,sent_at,email_id,status,created_at').in('lead_id', groupIds) : empty,
    groupIds.length ? supabase.from('dm_queue').select('id,lead_id,status,created_at').in('lead_id', groupIds) : empty,
    groupIds.length ? supabase.from('activity_log').select('id,lead_id,event_type,created_at').in('lead_id', groupIds) : empty,
    groupIds.length ? supabase.from('lead_data_quality_flags').select('id,lead_id,issue_type,status,created_at').in('lead_id', groupIds) : empty,
    supabase.from('recipient_outreach_ownership').select('normalized_email,owner_lead_id,state,claimed_at,last_activity_at').eq('normalized_email', input.normalized_email).limit(2),
  ])
  const firstError = emailResult.error ?? dealResult.error ?? followupResult.error ?? dmResult.error
    ?? activityResult.error ?? flagResult.error ?? ownershipResult.error
  if (firstError) throw new Error(firstError.message)

  const emails = rows<ConsolidationEmailSnapshot>(emailResult.data)
  const deals = rows<ConsolidationDealSnapshot>(dealResult.data)
  const followups = rows<ConsolidationFollowupSnapshot>(followupResult.data)
  const dmQueue = rows<ConsolidationLinkedRowSnapshot>(dmResult.data)
  const activity = rows<ConsolidationLinkedRowSnapshot>(activityResult.data)
  const dataQualityFlags = rows<ConsolidationLinkedRowSnapshot>(flagResult.data)
  const ownershipRows = rows<ConsolidationOwnershipSnapshot>(ownershipResult.data)

  // This token is returned for a future confirm RPC. Confirmation must lock and
  // recompute the same material before changing anything; a mismatch is stale.
  const versionMaterial = {
    leads: stableRows(groupLeads as unknown as Array<Record<string, unknown>>),
    emails: stableRows(emails as unknown as Array<Record<string, unknown>>),
    deals: stableRows(deals as unknown as Array<Record<string, unknown>>),
    followups: stableRows(followups as unknown as Array<Record<string, unknown>>),
    dm_queue: stableRows(dmQueue as unknown as Array<Record<string, unknown>>),
    ownership: [...ownershipRows].sort((a, b) => a.normalized_email.localeCompare(b.normalized_email)),
    flags: stableRows(dataQualityFlags as unknown as Array<Record<string, unknown>>),
  }
  const snapshot: ConsolidationSnapshot = {
    groupLeads, emails, deals, followups, dmQueue, activity, dataQualityFlags, ownershipRows,
    generatedAt: new Date().toISOString(),
    versionToken: createHash('sha256').update(JSON.stringify(versionMaterial)).digest('hex'),
  }
  return buildDuplicateConsolidationPreview(input, snapshot)
}
