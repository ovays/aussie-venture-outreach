import { createHash, timingSafeEqual } from 'node:crypto'

export interface HostingerWebhookLocator {
  eventType: string | null
  mailboxId?: string
  mailboxAddress?: string
  folder: string
  folderProvided?: boolean
  uid?: number
  providerMessageId?: string
  eventId?: string
  threadId?: string
  from?: string
  to?: string[]
  subject?: string
  receivedAt?: string
  inReplyTo?: string[]
  references?: string[]
  headers: Record<string, string>
}

export const HOSTINGER_INBOX_FOLDER = 'INBOX'

export function isHostingerInboxFolder(folder: string): boolean {
  return folder.trim().toUpperCase() === HOSTINGER_INBOX_FOLDER
}

export interface HostingerWebhookDiagnostics {
  topLevelKeys: string[]
  eventField?: string
  mailboxIdFields: string[]
  mailboxAddressFields: string[]
  locatorFields: string[]
}

export type HostingerWebhookParseResult =
  | { ok: true; locator: HostingerWebhookLocator; diagnostics: HostingerWebhookDiagnostics; isTest: boolean }
  | { ok: false; error: string; diagnostics: HostingerWebhookDiagnostics }

export const HOSTINGER_WEBHOOK_FIELD_ALIASES = {
  event: ['event', 'type', 'eventType', 'event_type'],
  mailboxId: [
    'resourceId', 'resource_id', 'mailboxResourceId', 'mailbox_resource_id',
    'accountResourceId', 'account_resource_id', 'mailboxId', 'mailbox_id',
  ],
  mailboxAddress: ['mailbox', 'mailboxAddress', 'mailbox_address', 'address', 'email'],
  folder: ['folder', 'path', 'folderPath', 'folder_path'],
  uid: ['uid', 'messageUid', 'message_uid'],
  messageId: ['messageId', 'message_id', 'providerMessageId', 'provider_message_id', 'id'],
  eventId: ['eventId', 'event_id', 'deliveryId', 'delivery_id'],
  threadId: ['threadId', 'thread_id'],
} as const

type JsonObject = Record<string, unknown>
type LocatedObject = { value: JsonObject | null; prefix: string }

const EMPTY_DIAGNOSTICS: HostingerWebhookDiagnostics = {
  topLevelKeys: [],
  mailboxIdFields: [],
  mailboxAddressFields: [],
  locatorFields: [],
}

export function verifyHostingerBearerSecret(
  authorization: string | null,
  expected: string | undefined,
): boolean {
  if (!authorization || !expected) return false
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  if (!match) return false

  const receivedDigest = createHash('sha256').update(match[1], 'utf8').digest()
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(receivedDigest, expectedDigest)
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function safeKeys(object: JsonObject): string[] {
  return Object.keys(object).slice(0, 30).map((key) => key.replace(/[^a-zA-Z0-9_.-]/g, '?').slice(0, 60))
}

function stringAt(objects: Array<JsonObject | null>, keys: readonly string[]): string | undefined {
  for (const object of objects) {
    if (!object) continue
    for (const key of keys) {
      const value = object[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    }
  }
  return undefined
}

function locatedString(objects: LocatedObject[], keys: readonly string[]): { value?: string; field?: string } {
  for (const object of objects) {
    if (!object.value) continue
    for (const key of keys) {
      const value = object.value[key]
      if (typeof value === 'string' && value.trim()) return { value: value.trim(), field: `${object.prefix}${key}` }
      if (typeof value === 'number' && Number.isFinite(value)) return { value: String(value), field: `${object.prefix}${key}` }
    }
  }
  return {}
}

function presentFields(objects: LocatedObject[], keys: readonly string[]): string[] {
  const fields: string[] = []
  for (const object of objects) {
    if (!object.value) continue
    for (const key of keys) {
      if (object.value[key] !== undefined) fields.push(`${object.prefix}${key}`)
    }
  }
  return [...new Set(fields)].slice(0, 30)
}

function address(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() && value.includes('@')) return value.trim()
  const object = asObject(value)
  return object ? stringAt([object], ['address', 'email']) : undefined
}

function addresses(value: unknown): string[] | undefined {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value]
  const result = list.map(address).filter((item): item is string => !!item)
  return result.length ? result : undefined
}

function addressAt(objects: Array<JsonObject | null>, keys: readonly string[]): string | undefined {
  for (const object of objects) {
    if (!object) continue
    for (const key of keys) {
      const value = address(object[key])
      if (value) return value
    }
  }
  return undefined
}

function addressesAt(objects: Array<JsonObject | null>, keys: readonly string[]): string[] | undefined {
  for (const object of objects) {
    if (!object) continue
    for (const key of keys) {
      const value = addresses(object[key])
      if (value) return value
    }
  }
  return undefined
}

function stringValues(value: unknown): string[] | undefined {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  const strings = values
    .filter((item): item is string => typeof item === 'string' && !!item.trim())
    .map((item) => item.trim())
  return strings.length ? strings : undefined
}

function webhookHeaders(message: JsonObject): Record<string, string> {
  const headersObject = asObject(message.headers)
  const headers: Record<string, string> = {}

  for (const [name, value] of Object.entries(headersObject ?? {})) {
    const values = stringValues(value)
    if (values?.length) headers[name.toLowerCase()] = values.join(', ')
  }

  const knownHeaders: Array<[string, string[]]> = [
    ['message-id', ['messageId', 'message_id']],
    ['in-reply-to', ['inReplyTo', 'in_reply_to']],
    ['references', ['references']],
    ['auto-submitted', ['autoSubmitted', 'auto_submitted']],
    ['precedence', ['precedence']],
    ['x-autoreply', ['xAutoreply', 'x_autoreply']],
    ['x-autorespond', ['xAutorespond', 'x_autorespond']],
  ]
  for (const [headerName, keys] of knownHeaders) {
    const value = stringAt([message], keys)
    if (value && !headers[headerName]) headers[headerName] = value
  }

  return headers
}

function explicitTestMarker(objects: Array<JsonObject | null>, eventType: string | null): boolean {
  if (eventType && ['test', 'webhook.test', 'webhook_test'].includes(eventType.toLowerCase())) return true
  return objects.some((object) => object?.test === true || object?.isTest === true || object?.is_test === true)
}

export function normalizeHostingerWebhookPayload(payload: unknown): HostingerWebhookParseResult {
  const root = asObject(payload)
  if (!root) return { ok: false, error: 'Payload must be a JSON object', diagnostics: EMPTY_DIAGNOSTICS }

  const data = asObject(root.data)
  const nestedPayload = asObject(root.payload)
  const resource = asObject(root.resource) ?? asObject(data?.resource) ?? asObject(nestedPayload?.resource)
  const message = asObject(root.message)
    ?? asObject(data?.message)
    ?? asObject(nestedPayload?.message)
    ?? asObject(resource?.message)
    ?? data
    ?? nestedPayload
    ?? resource
    ?? {}
  const mailboxObject = asObject(root.mailbox)
    ?? asObject(data?.mailbox)
    ?? asObject(nestedPayload?.mailbox)
    ?? asObject(resource?.mailbox)

  const containers: LocatedObject[] = [
    { value: message, prefix: 'message.' },
    { value: resource, prefix: 'resource.' },
    { value: data, prefix: 'data.' },
    { value: nestedPayload, prefix: 'payload.' },
    { value: root, prefix: '' },
  ]
  const mailboxContainers: LocatedObject[] = [
    { value: mailboxObject, prefix: 'mailbox.' },
    ...containers,
  ]
  const event = locatedString([
    { value: root, prefix: '' },
    { value: data, prefix: 'data.' },
    { value: nestedPayload, prefix: 'payload.' },
  ], HOSTINGER_WEBHOOK_FIELD_ALIASES.event)
  const mailboxId = locatedString(
    [{ value: mailboxObject, prefix: 'mailbox.' }],
    ['id', ...HOSTINGER_WEBHOOK_FIELD_ALIASES.mailboxId],
  )
  const fallbackMailboxId = mailboxId.value
    ? mailboxId
    : locatedString(containers, HOSTINGER_WEBHOOK_FIELD_ALIASES.mailboxId)
  const rawUid = locatedString(containers, HOSTINGER_WEBHOOK_FIELD_ALIASES.uid)
  const parsedUid = rawUid.value && /^\d+$/.test(rawUid.value) ? Number(rawUid.value) : undefined
  const numericUid = Number.isSafeInteger(parsedUid) ? parsedUid : undefined
  const messageId = locatedString([{ value: message, prefix: 'message.' }], HOSTINGER_WEBHOOK_FIELD_ALIASES.messageId)
  const fallbackMessageId = messageId.value
    ? messageId
    : locatedString(
      [
        { value: resource, prefix: 'resource.' },
        { value: data, prefix: 'data.' },
        { value: nestedPayload, prefix: 'payload.' },
        { value: root, prefix: '' },
      ],
      HOSTINGER_WEBHOOK_FIELD_ALIASES.messageId.slice(0, -1),
    )
  const eventId = locatedString(containers, HOSTINGER_WEBHOOK_FIELD_ALIASES.eventId)
  const threadId = locatedString(containers, HOSTINGER_WEBHOOK_FIELD_ALIASES.threadId)
  const folder = locatedString(containers, HOSTINGER_WEBHOOK_FIELD_ALIASES.folder)

  const mailboxAddress = address(root.mailbox)
    ?? address(data?.mailbox)
    ?? address(nestedPayload?.mailbox)
    ?? address(resource?.mailbox)
    ?? stringAt([mailboxObject, message, resource, data, nestedPayload, root], ['mailboxAddress', 'mailbox_address'])
  const mailboxAddressFields = presentFields(mailboxContainers, HOSTINGER_WEBHOOK_FIELD_ALIASES.mailboxAddress)
  const diagnostics: HostingerWebhookDiagnostics = {
    topLevelKeys: safeKeys(root),
    eventField: event.field,
    mailboxIdFields: presentFields(
      [{ value: mailboxObject, prefix: 'mailbox.' }],
      ['id', ...HOSTINGER_WEBHOOK_FIELD_ALIASES.mailboxId],
    ).concat(presentFields(containers, HOSTINGER_WEBHOOK_FIELD_ALIASES.mailboxId)).slice(0, 30),
    mailboxAddressFields,
    locatorFields: [rawUid.field, fallbackMessageId.field, eventId.field, threadId.field, folder.field]
      .filter((field): field is string => !!field),
  }

  if (!event.value) return { ok: false, error: 'Missing event type', diagnostics }

  const headers = webhookHeaders(message)
  const locator: HostingerWebhookLocator = {
    eventType: event.value,
    mailboxId: fallbackMailboxId.value,
    mailboxAddress,
    folder: folder.value ?? HOSTINGER_INBOX_FOLDER,
    folderProvided: !!folder.value,
    uid: numericUid && numericUid > 0 ? numericUid : undefined,
    providerMessageId: fallbackMessageId.value,
    eventId: eventId.value,
    threadId: threadId.value,
    from: addressAt([message, resource, data, nestedPayload, root], ['from', 'sender']),
    to: addressesAt([message, resource, data, nestedPayload, root], ['to', 'recipient', 'recipients']),
    subject: stringAt([message, resource, data, nestedPayload, root], ['subject']),
    receivedAt: stringAt(containers.map(({ value }) => value), ['receivedAt', 'received_at', 'timestamp', 'date', 'createdAt', 'created_at']),
    inReplyTo: stringValues(message.inReplyTo ?? message.in_reply_to ?? headers['in-reply-to']),
    references: stringValues(message.references ?? headers.references),
    headers,
  }

  return {
    ok: true,
    locator,
    diagnostics,
    isTest: explicitTestMarker([root, data, nestedPayload, resource, message], locator.eventType),
  }
}

export function parseHostingerWebhookPayload(payload: unknown): HostingerWebhookLocator {
  const parsed = normalizeHostingerWebhookPayload(payload)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.locator
}

export function validateHostingerMessageLocator(locator: HostingerWebhookLocator): string | null {
  if (!locator.mailboxId && !locator.mailboxAddress) return 'Missing mailbox identifier or address'
  if (!locator.folder.trim()) return 'Missing folder identifier'
  const resolvableFallback = !!locator.from && !!locator.receivedAt && (!!locator.threadId || !!locator.eventId)
  if (!locator.uid && !locator.providerMessageId && !resolvableFallback) return 'Missing stable message locator'
  return null
}
