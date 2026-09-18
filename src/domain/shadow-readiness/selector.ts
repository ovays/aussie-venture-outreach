import type { SupabaseClient } from '@supabase/supabase-js'
import { isLeadStatus, type LeadStatus } from '@/lib/lead-status'
import type { Database } from '@/types/database'
import { MAX_SHADOW_BATCH_SIZE } from './batch'

export interface ShadowSampleSelector {
  leadIds?: readonly string[]
  status?: LeadStatus
  limit?: number
  recentDays?: number
}

export async function selectShadowLeadIds(
  client: SupabaseClient<Database>,
  selector: ShadowSampleSelector,
  now = new Date(),
): Promise<string[]> {
  if (selector.leadIds?.length) {
    const ids = [...new Set(selector.leadIds.map((id) => id.trim()).filter(Boolean))]
    if (ids.length > MAX_SHADOW_BATCH_SIZE) throw new Error(`Shadow selection exceeds ${MAX_SHADOW_BATCH_SIZE} leads.`)
    return ids
  }
  if (!selector.limit || !Number.isSafeInteger(selector.limit) || selector.limit < 1 || selector.limit > MAX_SHADOW_BATCH_SIZE) {
    throw new Error(`Cohort shadow selection requires --limit between 1 and ${MAX_SHADOW_BATCH_SIZE}.`)
  }
  if (!selector.status && !selector.recentDays) throw new Error('Unbounded shadow selection rejected: provide --lead-id, --status, or --recent-days.')
  if (selector.status && !isLeadStatus(selector.status)) throw new Error(`Unsupported lead status: ${selector.status}`)
  if (selector.recentDays !== undefined && (!Number.isSafeInteger(selector.recentDays) || selector.recentDays < 1 || selector.recentDays > 365)) {
    throw new Error('--recent-days must be an integer between 1 and 365.')
  }
  let query = client.from('leads').select('id')
  if (selector.status) query = query.eq('status', selector.status)
  if (selector.recentDays) query = query.gte('updated_at', new Date(now.getTime() - selector.recentDays * 86_400_000).toISOString())
  const selected = await query.order('updated_at', { ascending: false }).order('id', { ascending: true }).limit(selector.limit)
  if (selected.error) throw new Error(`Shadow sample selection failed: ${selected.error.message}`)
  return (selected.data ?? []).map((lead) => lead.id)
}
