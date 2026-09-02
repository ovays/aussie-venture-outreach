import type { HostingerWebhookLocator } from '@/lib/hostinger-webhook'
import {
  normalizeHostingerWebhookPayload,
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

function locatorPresence(locator: HostingerWebhookLocator): Record<string, boolean> {
  return {
    mailbox_id: !!locator.mailboxId,
    mailbox_address: !!locator.mailboxAddress,
    folder: !!locator.folder,
    uid: !!locator.uid,
    message_id: !!locator.providerMessageId,
    event_id: !!locator.eventId,
    thread_id: !!locator.threadId,
    sender: !!locator.from,
    received_at: !!locator.receivedAt,
  }
}

function safeEventType(value: string | null): string | null {
  return value && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) ? value : null
}

export async function handleHostingerWebhookRequest(
  request: Request,
  dependencies: HostingerWebhookHandlerDependencies,
): Promise<Response> {
  if (!verifyHostingerBearerSecret(request.headers.get('authorization'), dependencies.webhookSecret)) {
    dependencies.log?.warn('Hostinger webhook rejected', {
      validation_failure: 'Missing or invalid Bearer webhook secret',
      http_status: 401,
    })
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    dependencies.log?.warn('Hostinger webhook rejected', {
      validation_failure: 'Invalid JSON',
      http_status: 400,
    })
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = normalizeHostingerWebhookPayload(payload)
  if (!parsed.ok) {
    dependencies.log?.warn('Hostinger webhook rejected', {
      top_level_keys: parsed.diagnostics.topLevelKeys,
      event_field: parsed.diagnostics.eventField ?? null,
      mailbox_id_fields: parsed.diagnostics.mailboxIdFields,
      mailbox_address_fields: parsed.diagnostics.mailboxAddressFields,
      locator_fields: parsed.diagnostics.locatorFields,
      validation_failure: parsed.error,
      http_status: 400,
    })
    return Response.json({ error: parsed.error }, { status: 400 })
  }

  const { locator } = parsed

  dependencies.log?.info('Hostinger webhook received', {
    event_type: safeEventType(locator.eventType),
    top_level_keys: parsed.diagnostics.topLevelKeys,
    event_field: parsed.diagnostics.eventField ?? null,
    mailbox_id_fields: parsed.diagnostics.mailboxIdFields,
    mailbox_address_fields: parsed.diagnostics.mailboxAddressFields,
    locator_fields: parsed.diagnostics.locatorFields,
    locator_presence: locatorPresence(locator),
  })

  if (parsed.isTest) {
    dependencies.log?.info('Hostinger webhook test acknowledged', {
      event_type: safeEventType(locator.eventType),
      http_status: 200,
    })
    return Response.json({ ok: true, test: true })
  }

  if (locator.eventType !== 'message.received') {
    dependencies.log?.info('Hostinger webhook event ignored', {
      event_type: safeEventType(locator.eventType),
      validation_failure: 'Unsupported event type',
      http_status: 200,
    })
    return Response.json({ ok: true, ignored: true })
  }

  const locatorError = validateHostingerMessageLocator(locator)
  if (locatorError) {
    dependencies.log?.warn('Hostinger webhook rejected', {
      event_type: safeEventType(locator.eventType),
      locator_presence: locatorPresence(locator),
      mailbox_id_fields: parsed.diagnostics.mailboxIdFields,
      mailbox_address_fields: parsed.diagnostics.mailboxAddressFields,
      locator_fields: parsed.diagnostics.locatorFields,
      validation_failure: locatorError,
      http_status: 400,
    })
    return Response.json({ error: locatorError }, { status: 400 })
  }

  if ((locator.mailboxId && !sameMailbox(locator.mailboxId, dependencies.mailboxId))
    || (locator.mailboxAddress && !sameMailbox(locator.mailboxAddress, dependencies.mailboxAddress))) {
    dependencies.log?.warn('Hostinger webhook ignored for an unexpected mailbox', {
      locator_presence: locatorPresence(locator),
      validation_failure: 'Mailbox identifier or address did not match configuration',
      http_status: 200,
    })
    return Response.json({ ok: true, ignored: true })
  }

  try {
    const accepted = await dependencies.accept(locator)
    dependencies.log?.info('Hostinger webhook accepted', {
      event_type: safeEventType(locator.eventType),
      duplicate: accepted.duplicate,
      queued: !!accepted.runId || accepted.status === 'queued' || accepted.status === 'pending',
      receipt_status: accepted.status,
      http_status: 202,
    })
    return Response.json({
      ok: true,
      queued: !!accepted.runId || accepted.status === 'queued' || accepted.status === 'pending',
      duplicate: accepted.duplicate,
      receipt_id: accepted.receiptId,
      run_id: accepted.runId ?? null,
      status: accepted.status,
    }, { status: 202 })
  } catch (error) {
    dependencies.log?.error('Error accepting Hostinger webhook event', {
      event_type: safeEventType(locator.eventType),
      locator_presence: locatorPresence(locator),
      validation_failure: 'Receipt registration or Trigger enqueue failed',
      http_status: 503,
      error_type: error instanceof Error ? error.name : 'UnknownError',
    })
    return Response.json({ error: 'Unable to queue event' }, { status: 503 })
  }
}
