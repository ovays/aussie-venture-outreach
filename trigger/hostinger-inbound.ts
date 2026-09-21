import { task } from '@trigger.dev/sdk/v3'
import { processHostingerInboundReceipt } from '../src/lib/hostinger-inbound-receipts'
import { validateHostingerInboundTaskPayload } from '../src/lib/hostinger-inbound-payload'
import { assertTriggerJobsEnabled } from '../src/lib/side-effect-safety'
import { withObservedStep, withObservedWorkflow } from '../src/lib/observability/service'

export const hostingerInboundTask = task({
  id: 'hostinger-inbound-message',
  queue: {
    name: 'hostinger-inbound',
    concurrencyLimit: 3,
  },
  maxDuration: 300,
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
    randomize: true,
  },
  run: async (payload: unknown, { ctx }) => {
    assertTriggerJobsEnabled('Hostinger inbound task')
    const validated = validateHostingerInboundTaskPayload(payload)
    return withObservedWorkflow({
      workspaceId: validated.workspaceId,
      workflowType: 'inbound_reply_processing', source: 'trigger.event',
      triggerTaskId: 'hostinger-inbound-message', triggerRunId: ctx.run.id,
      correlationId: validated.receiptId, idempotencyKey: validated.receiptId,
      attempt: ctx.attempt.number,
      metadata: { inbound_receipt_id: validated.receiptId, provider: 'hostinger' },
    }, () => withObservedStep({
      workspaceId: validated.workspaceId,
      stepName: 'process_inbound_receipt', stepType: 'provider_event', sequence: 10,
      attempt: ctx.attempt.number, provider: 'hostinger',
      inputSummary: { inbound_receipt_id: validated.receiptId },
    }, () => processHostingerInboundReceipt(validated.receiptId, ctx.run.id, validated.workspaceId), (result) => ({ outcome: result })))
  },
})
