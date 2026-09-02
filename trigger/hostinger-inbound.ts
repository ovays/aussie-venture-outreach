import { task } from '@trigger.dev/sdk/v3'
import { processHostingerInboundReceipt } from '../src/lib/hostinger-inbound-receipts'
import { validateHostingerInboundTaskPayload } from '../src/lib/hostinger-inbound-payload'

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
    const validated = validateHostingerInboundTaskPayload(payload)
    return processHostingerInboundReceipt(validated.receiptId, ctx.run.id)
  },
})
