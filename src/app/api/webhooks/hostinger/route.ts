import { NextRequest, NextResponse } from 'next/server'
import { auth, tasks } from '@trigger.dev/sdk/v3'
import type { hostingerInboundTask } from '../../../../../trigger/hostinger-inbound'
import { acceptHostingerInboundEvent } from '@/lib/hostinger-inbound-queue'
import { createHostingerInboundReceiptStore } from '@/lib/hostinger-inbound-receipts'
import { handleHostingerWebhookRequest } from '@/lib/hostinger-webhook-handler'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

export async function POST(request: NextRequest): Promise<NextResponse> {
  const store = createHostingerInboundReceiptStore()
  const response = await handleHostingerWebhookRequest(request, {
    webhookSecret: process.env.HOSTINGER_WEBHOOK_SECRET,
    mailboxId: process.env.HOSTINGER_MAILBOX_ID,
    mailboxAddress: process.env.HOSTINGER_MAILBOX_ADDRESS,
    accept: (locator) => acceptHostingerInboundEvent(locator, store, async (receiptId, idempotencyKey) => {
      const secretKey = process.env.TRIGGER_SECRET_KEY_PROD ?? process.env.TRIGGER_SECRET_KEY ?? ''
      return auth.withAuth(
        { accessToken: secretKey },
        () => tasks.trigger<typeof hostingerInboundTask>(
          'hostinger-inbound-message',
          { receiptId },
          { idempotencyKey, idempotencyKeyTTL: '24h' },
        ),
      )
    }),
    log: {
      info: (message, metadata) => logger.info('webhook', message, metadata),
      warn: (message, metadata) => logger.warn('webhook', message, metadata),
      error: (message, metadata) => logger.error('webhook', message, metadata),
    },
  })
  return new NextResponse(response.body, {
    status: response.status,
    headers: response.headers,
  })
}
