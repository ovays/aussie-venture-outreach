import assert from 'node:assert/strict'
import {
  createLeadsBulkProgress,
  runSequentialLeadsBulkOperation,
  type LeadsBulkOutcome,
} from '@/lib/leads-bulk-progress'

async function main() {
  assert.deepEqual(createLeadsBulkProgress(3), {
    total: 3,
    processed: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
  })

  const requested: string[] = []
  const snapshots: Array<{ processed: number; succeeded: number; skipped: number; failed: number }> = []
  const outcomes: Record<string, LeadsBulkOutcome | Error> = {
    success: { lead_id: 'success', status: 'succeeded' },
    skip: { lead_id: 'skip', status: 'skipped', reason: 'Already sent' },
    failure: new Error('Unconfirmed response'),
  }

  const result = await runSequentialLeadsBulkOperation({
    targetIds: ['success', 'skip', 'failure'],
    request: async (leadId) => {
      requested.push(leadId)
      const outcome = outcomes[leadId]
      if (outcome instanceof Error) throw outcome
      return outcome
    },
    failureOutcome: (leadId, error) => ({
      lead_id: leadId,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    }),
    onProgress: (progress) => snapshots.push({
      processed: progress.processed,
      succeeded: progress.succeeded,
      skipped: progress.skipped,
      failed: progress.failed,
    }),
  })

  assert.deepEqual(requested, ['success', 'skip', 'failure'], 'each target is requested exactly once')
  assert.deepEqual(snapshots, [
    { processed: 0, succeeded: 0, skipped: 0, failed: 0 },
    { processed: 1, succeeded: 1, skipped: 0, failed: 0 },
    { processed: 2, succeeded: 1, skipped: 1, failed: 0 },
    { processed: 3, succeeded: 1, skipped: 1, failed: 1 },
  ])
  assert.deepEqual(result.progress, {
    total: 3,
    processed: 3,
    succeeded: 1,
    skipped: 1,
    failed: 1,
  })

  const resetSnapshots: number[] = []
  await runSequentialLeadsBulkOperation({
    targetIds: ['new-operation'],
    request: async (leadId) => ({ lead_id: leadId, status: 'succeeded' }),
    failureOutcome: (leadId) => ({ lead_id: leadId, status: 'failed' }),
    onProgress: (progress) => resetSnapshots.push(progress.processed),
  })
  assert.deepEqual(resetSnapshots, [0, 1], 'a new operation starts from zero')

  console.log('Leads bulk progress checks passed')
}

main().catch((error) => { console.error(error); process.exit(1) })
