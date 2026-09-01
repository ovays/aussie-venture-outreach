import 'server-only'

import type { NormalizedInboundMessage } from '../../agents/tracker'
import { normalizeInboundEmailAddress, parseMessageIds } from '../../agents/tracker'
import type { HostingerWebhookLocator } from '@/lib/hostinger-webhook'
import { collectHostingerPages } from '@/lib/hostinger-pagination'

type JsonObject = Record<string, unknown>

interface HostingerAddress {
  name?: string
  address?: string
}

export interface HostingerMessageMetadata {
  uid: number
  path: string
  date?: string
  subject?: string | null
  from?: HostingerAddress | null
  to?: HostingerAddress[]
  cc?: HostingerAddress[]
  bcc?: HostingerAddress[]
  messageId?: string | null
  inReplyTo?: string | null
  references?: string | string[] | null
  headers?: Record<string, string | string[] | null> | null
  autoSubmitted?: string | null
  precedence?: string | null
  xAutoreply?: string | null
  xAutorespond?: string | null
  flags?: string[]
  unseen?: boolean
}

interface HostingerFolder {
  path: string
  specialUse?: string | null
}

interface HostingerPagination {
  page: number
  totalPages: number
}

export interface HostingerReportMailboxMessages {
  mailboxAddress: string
  sentFolder: string
  received: HostingerMessageMetadata[]
  sent: HostingerMessageMetadata[]
}

export interface HostingerReportSearchRange {
  startInclusive: Date
  endExclusive: Date
}

interface HostingerMailConfig {
  token: string
  mailboxId: string
  mailboxAddress: string
  baseUrl: string
}

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
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...init,
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/json',
      ...init.headers,
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

function isFolder(value: unknown): value is HostingerFolder {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as JsonObject
  return typeof row.path === 'string'
    && (row.specialUse === undefined || row.specialUse === null || typeof row.specialUse === 'string')
}

function responsePagination(value: unknown): HostingerPagination | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const pagination = (value as JsonObject).pagination
  if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination)) return null
  const row = pagination as JsonObject
  return typeof row.page === 'number' && Number.isInteger(row.page) && row.page > 0
    && typeof row.totalPages === 'number' && Number.isInteger(row.totalPages) && row.totalPages >= 0
    ? { page: row.page, totalPages: row.totalPages }
    : null
}

async function listAllFolders(
  config: HostingerMailConfig,
  fetchImpl: typeof fetch,
): Promise<HostingerFolder[]> {
  return collectHostingerPages(async (page) => {
    const url = `${config.baseUrl}/api/v1/mailboxes/${encodeURIComponent(config.mailboxId)}/folders?page=${page}&perPage=100`
    const payload = await hostingerFetchJson(url, config, fetchImpl)
    const data = responseData(payload)
    if (!Array.isArray(data) || !data.every(isFolder)) {
      throw new Error('Hostinger Mail API returned invalid folder metadata')
    }
    const pagination = responsePagination(payload)
    return { items: data, totalPages: pagination?.totalPages ?? null }
  })
}

export function detectHostingerSentFolder(folders: HostingerFolder[]): string {
  const specialUseMatch = folders.find((folder) => folder.specialUse?.toLowerCase() === '\\sent')
  if (specialUseMatch) return specialUseMatch.path

  const canonicalMatch = folders.find((folder) => folder.path.toLowerCase() === 'inbox.sent')
  if (canonicalMatch) return canonicalMatch.path

  throw new Error('Hostinger Sent folder could not be identified')
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000)
}

async function searchAllMessages(
  folder: string,
  range: HostingerReportSearchRange,
  config: HostingerMailConfig,
  fetchImpl: typeof fetch,
): Promise<HostingerMessageMetadata[]> {
  // Hostinger's search filter accepts dates, not instants. Use a deliberately
  // broad UTC-date window, then enforce exact Sydney boundaries from metadata.
  const since = range.startInclusive.toISOString().slice(0, 10)
  const before = addUtcDays(range.endExclusive, 1).toISOString().slice(0, 10)
  const messages = new Map<string, HostingerMessageMetadata>()
  const matching = await collectHostingerPages(async (page) => {
    const url = `${hostingerUrl(config, folder, '/search')}?page=${page}&perPage=100&sort=uid`
    const payload = await hostingerFetchJson(url, config, fetchImpl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since, before }),
    })
    const data = responseData(payload)
    if (!Array.isArray(data) || !data.every(isMessageMetadata)) {
      throw new Error('Hostinger Mail API returned invalid message metadata')
    }
    const pagination = responsePagination(payload)
    return { items: data, totalPages: pagination?.totalPages ?? null }
  })

  for (const message of matching) {
    const timestamp = message.date ? Date.parse(message.date) : Number.NaN
    if (Number.isFinite(timestamp)
      && timestamp >= range.startInclusive.getTime()
      && timestamp < range.endExclusive.getTime()) {
      messages.set(`${message.path}:${message.uid}`, message)
    }
  }

  return [...messages.values()]
}

export async function fetchHostingerReportMessages(
  range: HostingerReportSearchRange,
  fetchImpl: typeof fetch = fetch,
): Promise<HostingerReportMailboxMessages> {
  const config = configFromEnv()
  const folders = await listAllFolders(config, fetchImpl)
  const sentFolder = detectHostingerSentFolder(folders)
  const [received, sent] = await Promise.all([
    searchAllMessages('INBOX', range, config, fetchImpl),
    searchAllMessages(sentFolder, range, config, fetchImpl),
  ])

  return {
    mailboxAddress: config.mailboxAddress,
    sentFolder,
    received,
    sent,
  }
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

function metadataHeaders(
  message: HostingerMessageMetadata,
  locator: HostingerWebhookLocator,
): Record<string, string> {
  const headers: Record<string, string> = { ...locator.headers }
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (typeof value === 'string' && value.trim()) headers[name.toLowerCase()] = value.trim()
    if (Array.isArray(value)) {
      const values = value.filter((item): item is string => typeof item === 'string' && !!item.trim())
      if (values.length) headers[name.toLowerCase()] = values.join(', ')
    }
  }

  const known: Array<[string, string | null | undefined]> = [
    ['message-id', message.messageId],
    ['in-reply-to', message.inReplyTo],
    ['references', Array.isArray(message.references) ? message.references.join(' ') : message.references],
    ['auto-submitted', message.autoSubmitted],
    ['precedence', message.precedence],
    ['x-autoreply', message.xAutoreply],
    ['x-autorespond', message.xAutorespond],
  ]
  for (const [name, value] of known) {
    if (value?.trim() && !headers[name]) headers[name] = value.trim()
  }
  return headers
}

export async function fetchHostingerInboundMessage(
  locator: HostingerWebhookLocator,
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedInboundMessage> {
  const config = configFromEnv()
  const message = await getMessageMetadata(locator, config, fetchImpl)
  // The metadata endpoint does not return message bodies and does not change
  // flags. Never call /text (documented to set \Seen) or /source here.
  const headers = metadataHeaders(message, locator)
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
    inReplyTo: parseMessageIds([
      ...(locator.inReplyTo ?? []),
      message.inReplyTo ?? '',
      headers['in-reply-to'] ?? '',
    ]),
    references: parseMessageIds([
      ...(locator.references ?? []),
      ...(Array.isArray(message.references) ? message.references : [message.references ?? '']),
      headers.references ?? '',
    ]),
    headers,
    receivedAt: message.date ?? locator.receivedAt,
  }
}
