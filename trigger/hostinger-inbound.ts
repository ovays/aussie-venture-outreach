import { task } from '@trigger.dev/sdk/v3'
import { processHostingerInboundReceipt } from '../src/lib/hostinger-inbound-receipts'

export const hostingerInboundTask = task({
  id: 'hostinger-inbound-message',
  maxDuration: 300,
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 60_000,
    factor: 2,
    randomize: true,
  },
  run: async (payload: { receiptId: string }, { ctx }) => {
    return processHostingerInboundReceipt(payload.receiptId, ctx.run.id)
  },
})
