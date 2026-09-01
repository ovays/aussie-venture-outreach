import { createHash, timingSafeEqual } from 'node:crypto'

export interface HostingerWebhookLocator {
  eventType: string | null
  mailboxId?: string
  mailboxAddress?: string
  folder: string
  uid?: number
  providerMessageId?: string
  from?: string
  to?: string[]
  subject?: string
  receivedAt?: string
}

type JsonObject = Record<string, unknown>

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

function stringAt(objects: Array<JsonObject | null>, keys: string[]): string | undefined {
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

function address(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  const object = asObject(value)
  return object ? stringAt([object], ['address', 'email']) : undefined
}

function addresses(value: unknown): string[] | undefined {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value]
  const result = list.map(address).filter((item): item is string => !!item)
  return result.length ? result : undefined
}

export function parseHostingerWebhookPayload(payload: unknown): HostingerWebhookLocator {
  const root = asObject(payload) ?? {}
  const data = asObject(root.data)
  const nestedPayload = asObject(root.payload)
  const message = asObject(root.message)
    ?? asObject(data?.message)
    ?? asObject(nestedPayload?.message)
    ?? data
    ?? nestedPayload
    ?? {}
  const mailboxObject = asObject(root.mailbox) ?? asObject(data?.mailbox) ?? asObject(nestedPayload?.mailbox)
  const objects = [message, data, nestedPayload, root]

  const rawUid = stringAt(objects, ['uid', 'messageUid', 'message_uid'])
  const numericUid = rawUid && /^\d+$/.test(rawUid) ? Number(rawUid) : undefined
  const providerMessageId = stringAt(objects, [
    'messageId',
    'message_id',
    'providerMessageId',
    'provider_message_id',
    'id',
  ])

  return {
    eventType: stringAt([root], ['event', 'type', 'eventType', 'event_type']) ?? null,
    mailboxId: stringAt([mailboxObject, ...objects], [
      'resourceId',
      'resource_id',
      'mailboxResourceId',
      'mailbox_resource_id',
      'accountResourceId',
      'account_resource_id',
      'mailboxId',
      'mailbox_id',
    ]),
    mailboxAddress: address(root.mailbox)
      ?? address(data?.mailbox)
      ?? address(nestedPayload?.mailbox)
      ?? stringAt([mailboxObject, ...objects], ['mailboxAddress', 'mailbox_address']),
    folder: stringAt(objects, ['folder', 'path', 'folderPath', 'folder_path']) ?? 'INBOX',
    uid: numericUid && numericUid > 0 ? numericUid : undefined,
    providerMessageId,
    from: address(message.from ?? message.sender),
    to: addresses(message.to ?? message.recipient ?? message.recipients),
    subject: stringAt([message], ['subject']),
    receivedAt: stringAt(objects, ['receivedAt', 'received_at', 'timestamp', 'date', 'createdAt', 'created_at']),
  }
}
