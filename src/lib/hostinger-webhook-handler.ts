import type { HostingerWebhookLocator } from '@/lib/hostinger-webhook'
import {
  parseHostingerWebhookPayload,
  validateHostingerMessageLocator,
  verifyHostingerBearerSecret,
} from '@/lib/hostinger-webhook'

export interface HostingerWebhookAcceptance {
  receiptId: string
  runId?: string
  duplicate: boolean
  status: string
}

export interface HostingerWebhookHandlerDependencies {
  webhookSecret: string | undefined
  mailboxId: string | undefined
  mailboxAddress: string | undefined
  accept: (locator: HostingerWebhookLocator) => Promise<HostingerWebhookAcceptance>
  log?: {
    info: (message: string, metadata?: Record<string, unknown>) => void
    warn: (message: string, metadata?: Record<string, unknown>) => void
    error: (message: string, metadata?: Record<string, unknown>) => void
  }
}

function sameMailbox(value: string | undefined, expected: string | undefined): boolean {
  return !expected || (!!value && value.trim().toLowerCase() === expected.trim().toLowerCase())
}

export async function handleHostingerWebhookRequest(
  request: Request,
  dependencies: HostingerWebhookHandlerDependencies,
): Promise<Response> {
  if (!verifyHostingerBearerSecret(request.headers.get('authorization'), dependencies.webhookSecret)) {
    dependencies.log?.warn('Hostinger webhook authentication failed')
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let locator: HostingerWebhookLocator
  try {
    locator = parseHostingerWebhookPayload(await request.json())
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  dependencies.log?.info('Hostinger webhook received', {
    event_type: locator.eventType,
    mailbox_id: locator.mailboxId ?? null,
    folder: locator.folder,
    uid: locator.uid ?? null,
    provider_message_id: locator.providerMessageId ?? null,
  })

  if (locator.eventType !== 'message.received') {
    return Response.json({ ok: true, ignored: true })
  }

  const locatorError = validateHostingerMessageLocator(locator)
  if (locatorError) return Response.json({ error: locatorError }, { status: 400 })

  if (!sameMailbox(locator.mailboxId, dependencies.mailboxId)
    || (locator.mailboxAddress && !sameMailbox(locator.mailboxAddress, dependencies.mailboxAddress))) {
    dependencies.log?.warn('Hostinger webhook ignored for an unexpected mailbox', {
      mailbox_id: locator.mailboxId ?? null,
      mailbox_address: locator.mailboxAddress ?? null,
    })
    return Response.json({ ok: true, ignored: true })
  }

  try {
    const accepted = await dependencies.accept(locator)
    return Response.json({
      ok: true,
      queued: accepted.status === 'queued' || accepted.status === 'pending',
      duplicate: accepted.duplicate,
      receipt_id: accepted.receiptId,
      run_id: accepted.runId ?? null,
      status: accepted.status,
    }, { status: 202 })
  } catch (error) {
    dependencies.log?.error('Error accepting Hostinger webhook event', {
      event_type: locator.eventType,
      mailbox_id: locator.mailboxId ?? null,
      folder: locator.folder,
      uid: locator.uid ?? null,
      provider_message_id: locator.providerMessageId ?? null,
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json({ error: 'Unable to queue event' }, { status: 503 })
  }
}
