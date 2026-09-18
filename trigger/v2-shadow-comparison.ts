import { task } from '@trigger.dev/sdk/v3'
import { runShadowReport, SHADOW_TARGETS } from '../src/domain/shadow-readiness'
import { assertTriggerJobsEnabled } from '../src/lib/side-effect-safety'
import type { LeadStatus } from '../src/lib/lead-status'

interface ShadowTaskPayload {
  target: (typeof SHADOW_TARGETS)[number]
  leadIds?: string[]
  status?: LeadStatus
  limit?: number
  recentDays?: number
  acknowledgeProductionRead?: boolean
}

// Deliberately unscheduled. Future invocation requires the Trigger gate plus
// the independent shadow kill switch and bounded selector assertions.
export const v2ShadowComparisonTask = task({
  id: 'v2-shadow-comparison',
  queue: { concurrencyLimit: 1 },
  maxDuration: 300,
  run: async (payload: ShadowTaskPayload, { ctx }) => {
    assertTriggerJobsEnabled('dedicated V2 shadow comparison')
    return runShadowReport({
      safety: { target: payload.target, productionReadAcknowledged: payload.acknowledgeProductionRead },
      selector: { leadIds: payload.leadIds, status: payload.status, limit: payload.limit, recentDays: payload.recentDays },
      source: 'trigger.v2-shadow-comparison',
    }).then((report) => ({ correlationId: report.correlationId, summary: report.summary, target: report.target, triggerRunId: ctx.run.id }))
  },
})
