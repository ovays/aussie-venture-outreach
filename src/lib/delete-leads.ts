import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'

const leadIdsSchema = z.array(z.string().uuid()).max(10_000)

export class LeadIdsValidationError extends Error {}

export interface DeleteLeadsResult {
  requested: number
  matched: number
  deleted: number
  missing: number
  deleted_ids: string[]
  missing_ids: string[]
}

export function normalizeLeadIds(value: unknown): string[] {
  const parsed = leadIdsSchema.safeParse(value)
  if (!parsed.success) {
    throw new LeadIdsValidationError('lead_ids must be an array of at most 10,000 valid UUIDs')
  }
  return [...new Set(parsed.data)]
}

export async function deleteLeads(
  supabase: SupabaseClient,
  leadIds: string[],
): Promise<DeleteLeadsResult> {
  if (leadIds.length === 0) {
    return { requested: 0, matched: 0, deleted: 0, missing: 0, deleted_ids: [], missing_ids: [] }
  }

  const { data: existing, error: findError } = await supabase
    .from('leads')
    .select('id')
    .in('id', leadIds)

  if (findError) throw new Error(findError.message)

  const existingIds = (existing ?? []).map(({ id }) => String(id))
  const existingSet = new Set(existingIds)
  const missingIds = leadIds.filter((id) => !existingSet.has(id))

  if (existingIds.length === 0) {
    return {
      requested: leadIds.length,
      matched: 0,
      deleted: 0,
      missing: missingIds.length,
      deleted_ids: [],
      missing_ids: missingIds,
    }
  }

  // Keep the established single-lead deletion order. activity_log is
  // intentionally omitted: its ON DELETE SET NULL foreign key preserves audit
  // history after the lead and cascading email records have been removed.
  for (const table of ['follow_ups', 'dm_queue', 'deals', 'emails'] as const) {
    const { error } = await supabase.from(table).delete().in('lead_id', existingIds)
    if (error) throw new Error(error.message)
  }

  const { data: deleted, error: deleteError } = await supabase
    .from('leads')
    .delete()
    .in('id', existingIds)
    .select('id')

  if (deleteError) throw new Error(deleteError.message)

  const deletedIds = (deleted ?? []).map(({ id }) => String(id))
  const deletedSet = new Set(deletedIds)
  const concurrentlyMissing = existingIds.filter((id) => !deletedSet.has(id))
  const allMissingIds = [...missingIds, ...concurrentlyMissing]

  return {
    requested: leadIds.length,
    matched: existingIds.length,
    deleted: deletedIds.length,
    missing: allMissingIds.length,
    deleted_ids: deletedIds,
    missing_ids: allMissingIds,
  }
}
