import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'

const leadIdsSchema = z.array(z.string().uuid())

// Supabase serializes `.in()` filters into the URL. One hundred UUIDs keep each
// server-to-database request comfortably below common proxy URL limits while
// allowing the browser to make one bulk-delete request of any practical size.
export const LEAD_DELETE_BATCH_SIZE = 100

export class LeadIdsValidationError extends Error {}

export class LeadDeletionError extends Error {
  constructor(
    message: string,
    public readonly phase: 'lookup' | 'delete',
    public readonly batch: number,
    public readonly partialResult: DeleteLeadsResult,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'LeadDeletionError'
  }
}

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
    throw new LeadIdsValidationError('lead_ids must be an array containing only valid UUIDs')
  }
  return [...new Set(parsed.data.map((id) => id.toLowerCase()))]
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size))
  }
  return result
}

function resultFor(
  requestedIds: string[],
  matchedIds: string[],
  deletedIds: string[],
  missingIds: string[],
): DeleteLeadsResult {
  return {
    requested: requestedIds.length,
    matched: matchedIds.length,
    deleted: deletedIds.length,
    missing: missingIds.length,
    deleted_ids: deletedIds,
    missing_ids: missingIds,
  }
}

export async function deleteLeads(
  supabase: SupabaseClient,
  leadIds: string[],
): Promise<DeleteLeadsResult> {
  if (leadIds.length === 0) {
    return { requested: 0, matched: 0, deleted: 0, missing: 0, deleted_ids: [], missing_ids: [] }
  }

  const existingIds: string[] = []
  const lookupBatches = chunks(leadIds, LEAD_DELETE_BATCH_SIZE)
  for (const [index, batch] of lookupBatches.entries()) {
    const { data, error } = await supabase.from('leads').select('id').in('id', batch)
    if (error) {
      throw new LeadDeletionError(
        `Lead lookup batch ${index + 1} of ${lookupBatches.length} failed: ${error.message}`,
        'lookup',
        index + 1,
        resultFor(leadIds, existingIds, [], []),
        { cause: error },
      )
    }
    existingIds.push(...(data ?? []).map(({ id }) => String(id)))
  }

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

  const deletedIds: string[] = []
  const allMissingIds = [...missingIds]
  const deleteBatches = chunks(existingIds, LEAD_DELETE_BATCH_SIZE)
  for (const [index, batch] of deleteBatches.entries()) {
    // The existing foreign keys preserve the established semantics atomically
    // for each statement: follow_ups, dm_queue, deals, and emails cascade;
    // activity_log uses ON DELETE SET NULL and retains its audit history.
    const { data, error } = await supabase.from('leads').delete().in('id', batch).select('id')
    if (error) {
      throw new LeadDeletionError(
        `Lead delete batch ${index + 1} of ${deleteBatches.length} failed: ${error.message}`,
        'delete',
        index + 1,
        resultFor(leadIds, existingIds, deletedIds, allMissingIds),
        { cause: error },
      )
    }

    const batchDeletedIds = (data ?? []).map(({ id }) => String(id))
    const batchDeletedSet = new Set(batchDeletedIds)
    deletedIds.push(...batchDeletedIds)
    allMissingIds.push(...batch.filter((id) => !batchDeletedSet.has(id)))
  }

  return resultFor(leadIds, existingIds, deletedIds, allMissingIds)
}
