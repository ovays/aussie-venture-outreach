import type { SupabaseClient } from '@supabase/supabase-js'
import {
  deleteLeads,
  LeadDeletionError,
  LeadIdsValidationError,
  normalizeLeadIds,
} from '@/lib/delete-leads'

interface BulkDeleteDependencies {
  authenticate: () => Promise<Response | null>
  createClient: () => Promise<SupabaseClient>
  logError?: (message: string, context: unknown) => void
}

export async function handleBulkDeleteRequest(
  request: Request,
  dependencies: BulkDeleteDependencies,
): Promise<Response> {
  const authError = await dependencies.authenticate()
  if (authError) return authError

  try {
    const body = await request.json() as unknown
    const leadIds = normalizeLeadIds(
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).lead_ids
        : undefined,
    )
    const result = await deleteLeads(await dependencies.createClient(), leadIds)
    return Response.json(result)
  } catch (error) {
    if (error instanceof LeadIdsValidationError || error instanceof SyntaxError) {
      return Response.json({ error: error.message || 'Invalid JSON body' }, { status: 400 })
    }
    if (error instanceof LeadDeletionError) {
      dependencies.logError?.('Bulk lead deletion failed', {
        message: error.message,
        phase: error.phase,
        batch: error.batch,
        partialResult: error.partialResult,
        cause: error.cause,
      })
      return Response.json(
        {
          error: error.message,
          phase: error.phase,
          batch: error.batch,
          partial_result: error.partialResult,
        },
        { status: 500 },
      )
    }
    dependencies.logError?.('Unexpected bulk lead deletion error', error)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Could not delete leads' },
      { status: 500 },
    )
  }
}
