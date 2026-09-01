import { NextRequest, NextResponse } from 'next/server'
import { processInboundReply } from '../../../../../agents/tracker'
import { fetchHostingerInboundMessage } from '@/lib/hostinger-mail'
import { parseHostingerWebhookPayload, verifyHostingerBearerSecret } from '@/lib/hostinger-webhook'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

function sameMailbox(value: string | undefined, expected: string | undefined): boolean {
  return !value || !expected || value.trim().toLowerCase() === expected.trim().toLowerCase()
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyHostingerBearerSecret(request.headers.get('authorization'), process.env.HOSTINGER_WEBHOOK_SECRET)) {
    logger.warn('webhook', 'Hostinger webhook authentication failed')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let locator
  try {
    locator = parseHostingerWebhookPayload(await request.json())
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  logger.info('webhook', 'Hostinger webhook received', {
    event_type: locator.eventType,
    mailbox_id: locator.mailboxId ?? null,
    folder: locator.folder,
    uid: locator.uid ?? null,
    provider_message_id: locator.providerMessageId ?? null,
  })

  if (locator.eventType !== 'message.received') {
    return NextResponse.json({ ok: true, ignored: true })
  }

  if (!sameMailbox(locator.mailboxId, process.env.HOSTINGER_MAILBOX_ID)
    || !sameMailbox(locator.mailboxAddress, process.env.HOSTINGER_MAILBOX_ADDRESS)) {
    logger.warn('webhook', 'Hostinger webhook ignored for an unexpected mailbox', {
      mailbox_id: locator.mailboxId ?? null,
      mailbox_address: locator.mailboxAddress ?? null,
    })
    return NextResponse.json({ ok: true, ignored: true })
  }

  try {
    const message = await fetchHostingerInboundMessage(locator)
    const result = await processInboundReply(message)
    return NextResponse.json({ ok: true, outcome: result.outcome })
  } catch (error) {
    logger.error('webhook', 'Error handling Hostinger webhook event', {
      event_type: locator.eventType,
      mailbox_id: locator.mailboxId ?? process.env.HOSTINGER_MAILBOX_ID ?? null,
      folder: locator.folder,
      uid: locator.uid ?? null,
      provider_message_id: locator.providerMessageId ?? null,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
