import { createHash } from 'node:crypto'
import type { HostingerWebhookLocator } from '@/lib/hostinger-webhook'
import type { HostingerWebhookAcceptance } from '@/lib/hostinger-webhook-handler'

export type InboundReceiptStatus =
  | 'pending'
  | 'queued'
  | 'processing'
  | 'processed'
  | 'ignored'
  | 'unmatched'
  | 'unmatched_ambiguous'
  | 'failed'

export const HOSTINGER_PROCESSING_STALE_MS = 10 * 60_000

export interface HostingerInboundReceipt {
  id: string
  receiptKey: string
  status: InboundReceiptStatus
  duplicate: boolean
  attemptCount: number
  replayable: boolean
}

export interface HostingerInboundReceiptStore {
  register(locator: HostingerWebhookLocator): Promise<HostingerInboundReceipt>
  markQueued(receiptId: string, runId: string): Promise<InboundReceiptStatus>
  recordEnqueueError(receiptId: string, error: string): Promise<void>
}

export function hostingerInboundReceiptKey(locator: HostingerWebhookLocator): string {
  const mailbox = (locator.mailboxId ?? locator.mailboxAddress ?? '').trim().toLowerCase()
  const folder = locator.folder.trim().toLowerCase()
  const message = locator.uid
    ? `uid:${locator.uid}`
    : locator.providerMessageId
      ? `message-id:${locator.providerMessageId.trim()}`
      : locator.eventId
        ? `event-id:${locator.eventId.trim()}`
        : `thread:${locator.threadId?.trim() ?? ''}\nreceived:${locator.receivedAt?.trim() ?? ''}\nfrom:${locator.from?.trim().toLowerCase() ?? ''}`
  return createHash('sha256').update(`hostinger\n${mailbox}\n${folder}\n${message}`).digest('hex')
}

export async function acceptHostingerInboundEvent(
  locator: HostingerWebhookLocator,
  store: HostingerInboundReceiptStore,
  enqueue: (receiptId: string, idempotencyKey: string) => Promise<{ id: string }>,
): Promise<HostingerWebhookAcceptance> {
  const receipt = await store.register(locator)
  if (!receipt.replayable) {
    return {
      receiptId: receipt.id,
      duplicate: true,
      status: receipt.status,
    }
  }

  try {
    // The processing-attempt suffix changes only after a worker successfully
    // claims the receipt. If enqueue succeeds but markQueued fails, a webhook
    // retry therefore reuses the same Trigger idempotency key and run.
    const idempotencyKey = `hostinger-inbound-${receipt.receiptKey}-attempt-${receipt.attemptCount}`
    const handle = await enqueue(receipt.id, idempotencyKey)
    const status = await store.markQueued(receipt.id, handle.id)
    return {
      receiptId: receipt.id,
      runId: handle.id,
      duplicate: receipt.duplicate,
      status,
    }
  } catch (error) {
    await store.recordEnqueueError(receipt.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}
