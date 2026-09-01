import 'server-only'

import type { NormalizedInboundMessage } from '../../agents/tracker'
import { normalizeInboundEmailAddress, parseMessageIds } from '../../agents/tracker'
import type { HostingerWebhookLocator } from '@/lib/hostinger-webhook'

type JsonObject = Record<string, unknown>

interface HostingerAddress {
  name?: string
  address?: string
}

interface HostingerMessageMetadata {
  uid: number
  path: string
  date?: string
  subject?: string | null
  from?: HostingerAddress | null
  to?: HostingerAddress[]
  messageId?: string | null
  inReplyTo?: string | null
}

interface HostingerMailConfig {
  token: string
  mailboxId: string
  mailboxAddress: string
  baseUrl: string
}

const MAX_HEADER_BYTES = 256 * 1024

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function configFromEnv(): HostingerMailConfig {
  return {
    token: requiredEnv('HOSTINGER_MAIL_API_TOKEN'),
    mailboxId: requiredEnv('HOSTINGER_MAILBOX_ID'),
    mailboxAddress: requiredEnv('HOSTINGER_MAILBOX_ADDRESS'),
    baseUrl: requiredEnv('HOSTINGER_MAIL_API_BASE_URL').replace(/\/+$/, ''),
  }
}

function hostingerUrl(config: HostingerMailConfig, folder: string, suffix = ''): string {
  return `${config.baseUrl}/api/v1/mailboxes/${encodeURIComponent(config.mailboxId)}/folders/${encodeURIComponent(folder)}/messages${suffix}`
}

async function hostingerFetchJson(
  url: string,
  config: HostingerMailConfig,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/json',
    },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Hostinger Mail API request failed with status ${response.status}`)
  return response.json()
}

function responseData(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return (value as JsonObject).data
}

function isMessageMetadata(value: unknown): value is HostingerMessageMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as JsonObject
  return typeof row.uid === 'number' && typeof row.path === 'string'
}

async function listRecentMessages(
  folder: string,
  config: HostingerMailConfig,
  fetchImpl: typeof fetch,
): Promise<HostingerMessageMetadata[]> {
  const url = `${hostingerUrl(config, folder)}?page=1&perPage=50&sort=-uid`
  const payload = await hostingerFetchJson(url, config, fetchImpl)
  const data = responseData(payload)
  return Array.isArray(data) ? data.filter(isMessageMetadata) : []
}

function closeTimestamp(a?: string, b?: string): boolean {
  if (!a || !b) return true
  const aTime = Date.parse(a)
  const bTime = Date.parse(b)
  return !Number.isFinite(aTime) || !Number.isFinite(bTime) || Math.abs(aTime - bTime) <= 10 * 60_000
}

function selectUniqueRecentMessage(
  messages: HostingerMessageMetadata[],
  locator: HostingerWebhookLocator,
): HostingerMessageMetadata | null {
  const providerId = locator.providerMessageId
  if (providerId) {
    const byMessageId = messages.filter((message) => message.messageId === providerId)
    if (byMessageId.length === 1) return byMessageId[0]
  }

  const normalizedFrom = locator.from ? normalizeInboundEmailAddress(locator.from) : undefined
  const candidates = messages.filter((message) => {
    if (normalizedFrom && normalizeInboundEmailAddress(message.from?.address ?? '') !== normalizedFrom) return false
    if (locator.subject && message.subject !== locator.subject) return false
    return closeTimestamp(message.date, locator.receivedAt)
  })
  return candidates.length === 1 ? candidates[0] : null
}

async function getMessageMetadata(
  locator: HostingerWebhookLocator,
  config: HostingerMailConfig,
  fetchImpl: typeof fetch,
): Promise<HostingerMessageMetadata> {
  if (locator.uid) {
    const payload = await hostingerFetchJson(
      hostingerUrl(config, locator.folder, `/${locator.uid}`),
      config,
      fetchImpl,
    )
    const data = responseData(payload)
    if (!isMessageMetadata(data)) throw new Error('Hostinger Mail API returned invalid message metadata')
    return data
  }

  const match = selectUniqueRecentMessage(
    await listRecentMessages(locator.folder, config, fetchImpl),
    locator,
  )
  if (!match) throw new Error('Hostinger webhook message could not be uniquely resolved to a mailbox UID')
  return match
}

function headerBoundary(value: string): number {
  const crlf = value.indexOf('\r\n\r\n')
  const lf = value.indexOf('\n\n')
  if (crlf < 0) return lf < 0 ? -1 : lf + 2
  if (lf < 0) return crlf + 4
  return Math.min(crlf + 4, lf + 2)
}

async function readHeaderSection(response: Response): Promise<string> {
  if (!response.body) throw new Error('Hostinger message source response had no body stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let headers = ''
  let bytesRead = 0

  try {
    while (bytesRead < MAX_HEADER_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      headers += decoder.decode(value, { stream: true })
      const boundary = headerBoundary(headers)
      if (boundary >= 0) return headers.slice(0, boundary)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }

  throw new Error('Hostinger message headers were missing or exceeded the safety limit')
}

function parseRfcHeaders(source: string): Record<string, string> {
  const result: Record<string, string> = {}
  let currentName: string | null = null

  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    if (!line) break
    if (/^[ \t]/.test(line) && currentName) {
      result[currentName] = `${result[currentName]} ${line.trim()}`
      continue
    }

    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    result[name] = result[name] ? `${result[name]}, ${value}` : value
    currentName = name
  }

  return result
}

async function getMessageHeaders(
  message: HostingerMessageMetadata,
  config: HostingerMailConfig,
  fetchImpl: typeof fetch,
): Promise<Record<string, string>> {
  const response = await fetchImpl(
    hostingerUrl(config, message.path, `/${message.uid}/source`),
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'message/rfc822',
      },
      cache: 'no-store',
    },
  )
  if (!response.ok) throw new Error(`Hostinger message header request failed with status ${response.status}`)
  return parseRfcHeaders(await readHeaderSection(response))
}

export async function fetchHostingerInboundMessage(
  locator: HostingerWebhookLocator,
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedInboundMessage> {
  const config = configFromEnv()
  const message = await getMessageMetadata(locator, config, fetchImpl)
  const headers = await getMessageHeaders(message, config, fetchImpl)
  const from = message.from?.address ?? locator.from
  if (!from) throw new Error('Hostinger message metadata did not include a sender')

  return {
    provider: 'hostinger',
    providerMessageId: locator.providerMessageId ?? message.messageId ?? `${config.mailboxId}:${message.path}:${message.uid}`,
    mailboxId: config.mailboxId,
    folder: message.path,
    uid: message.uid,
    from,
    to: message.to?.map((recipient) => recipient.address).filter((item): item is string => !!item) ?? [],
    subject: message.subject ?? locator.subject,
    messageId: message.messageId ?? headers['message-id'],
    inReplyTo: parseMessageIds([message.inReplyTo ?? '', headers['in-reply-to'] ?? '']),
    references: parseMessageIds(headers.references),
    headers,
    receivedAt: message.date ?? locator.receivedAt,
  }
}

