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

export interface HostingerInboundReceipt {
  id: string
  receiptKey: string
  status: InboundReceiptStatus
  duplicate: boolean
}

export interface HostingerInboundReceiptStore {
  register(locator: HostingerWebhookLocator): Promise<HostingerInboundReceipt>
  markQueued(receiptId: string, runId: string): Promise<void>
  recordEnqueueError(receiptId: string, error: string): Promise<void>
}

export function hostingerInboundReceiptKey(locator: HostingerWebhookLocator): string {
  const mailbox = locator.mailboxId?.trim().toLowerCase() ?? ''
  const folder = locator.folder.trim().toLowerCase()
  const message = locator.uid ? `uid:${locator.uid}` : `message-id:${locator.providerMessageId?.trim() ?? ''}`
  return createHash('sha256').update(`hostinger\n${mailbox}\n${folder}\n${message}`).digest('hex')
}

export async function acceptHostingerInboundEvent(
  locator: HostingerWebhookLocator,
  store: HostingerInboundReceiptStore,
  enqueue: (receiptId: string, idempotencyKey: string) => Promise<{ id: string }>,
): Promise<HostingerWebhookAcceptance> {
  const receipt = await store.register(locator)
  if (receipt.status !== 'pending') {
    return {
      receiptId: receipt.id,
      duplicate: true,
      status: receipt.status,
    }
  }

  try {
    const handle = await enqueue(receipt.id, `hostinger-inbound-${receipt.receiptKey}`)
    await store.markQueued(receipt.id, handle.id)
    return {
      receiptId: receipt.id,
      runId: handle.id,
      duplicate: receipt.duplicate,
      status: 'queued',
    }
  } catch (error) {
    await store.recordEnqueueError(receipt.id, error instanceof Error ? error.message : String(error))
    throw error
  }
}
