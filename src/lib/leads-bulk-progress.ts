export type LeadsBulkOutcomeStatus = 'succeeded' | 'skipped' | 'failed'

export interface LeadsBulkOutcome {
  lead_id: string
  business_name?: string
  status: LeadsBulkOutcomeStatus
  reason?: string
}

export interface LeadsBulkProgress {
  total: number
  processed: number
  succeeded: number
  skipped: number
  failed: number
}

export interface LeadsBulkOperationResponse {
  progress: LeadsBulkProgress
  outcomes: LeadsBulkOutcome[]
  error?: string
}

export function createLeadsBulkProgress(total: number): LeadsBulkProgress {
  return { total, processed: 0, succeeded: 0, skipped: 0, failed: 0 }
}

export function applyLeadsBulkOutcomes(
  progress: LeadsBulkProgress,
  outcomes: readonly LeadsBulkOutcome[],
): LeadsBulkProgress {
  return outcomes.reduce((next, outcome) => ({
    ...next,
    processed: next.processed + 1,
    succeeded: next.succeeded + (outcome.status === 'succeeded' ? 1 : 0),
    skipped: next.skipped + (outcome.status === 'skipped' ? 1 : 0),
    failed: next.failed + (outcome.status === 'failed' ? 1 : 0),
  }), progress)
}

export function summarizeLeadsBulkOutcomes(
  total: number,
  outcomes: readonly LeadsBulkOutcome[],
): LeadsBulkProgress {
  return applyLeadsBulkOutcomes(createLeadsBulkProgress(total), outcomes)
}

export async function runSequentialLeadsBulkOperation({
  targetIds,
  request,
  failureOutcome,
  onProgress,
}: {
  targetIds: readonly string[]
  request: (leadId: string) => Promise<LeadsBulkOutcome>
  failureOutcome: (leadId: string, error: unknown) => LeadsBulkOutcome
  onProgress?: (progress: LeadsBulkProgress, outcomes: readonly LeadsBulkOutcome[]) => void
}): Promise<{ progress: LeadsBulkProgress; outcomes: LeadsBulkOutcome[] }> {
  let progress = createLeadsBulkProgress(targetIds.length)
  const outcomes: LeadsBulkOutcome[] = []
  onProgress?.(progress, outcomes)

  for (const leadId of targetIds) {
    let outcome: LeadsBulkOutcome
    try {
      outcome = await request(leadId)
    } catch (error) {
      outcome = failureOutcome(leadId, error)
    }
    outcomes.push(outcome)
    progress = applyLeadsBulkOutcomes(progress, [outcome])
    onProgress?.(progress, outcomes)
  }

  return { progress, outcomes }
}
