import type { createServiceClient } from '@/lib/supabase/server'
import type { LeadDedupeIndex } from '@/lib/deduplication'
import type { InitialEmailMode } from '@/lib/settingsDefaults'
import { writeOneLead, type WriteableLeadRow, type WriteOneLeadResult } from '@/lib/write-lead'
import type { LeadsBulkOutcome } from '@/lib/leads-bulk-progress'

export type ResearchedLeadForInitialEmail = WriteableLeadRow & { status: string }

type InitialEmailWriter = (
  supabase: ReturnType<typeof createServiceClient>,
  lead: WriteableLeadRow,
  dedupeIndex: LeadDedupeIndex,
  mode: InitialEmailMode,
) => Promise<WriteOneLeadResult>

export async function processResearchedLead(
  supabase: ReturnType<typeof createServiceClient>,
  lead: ResearchedLeadForInitialEmail,
  dedupeIndex: LeadDedupeIndex,
  mode: InitialEmailMode,
  writer: InitialEmailWriter = writeOneLead,
): Promise<LeadsBulkOutcome> {
  const base = { lead_id: lead.id, business_name: lead.business_name }

  if (lead.status !== 'researched') {
    return { ...base, status: 'skipped', reason: `Status is ${lead.status}, not researched` }
  }
  if (!lead.email) {
    return { ...base, status: 'skipped', reason: 'No email address' }
  }

  const result = await writer(supabase, lead, dedupeIndex, mode)
  if (!result.success) {
    return { ...base, status: 'failed', reason: `Initial Email generation failed: ${result.error}` }
  }
  if (result.channel !== 'email') {
    return result.channel === 'dead'
      ? { ...base, status: 'skipped', reason: 'No email address' }
      : { ...base, status: 'skipped', reason: 'Duplicate email — skipped' }
  }
  if (result.outcome === 'existing') {
    return { ...base, status: 'skipped', reason: 'An Initial Email already exists — no duplicate was created' }
  }

  return { ...base, status: 'succeeded' }
}
