import type { NormalizedInboundProviderMessage, MailboxProviderType } from './types'

function string(value: unknown, max = 500): string | undefined { return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined }
function addresses(value: unknown): string[] { return Array.isArray(value) ? value.map((item) => string(item, 320)).filter((item): item is string => !!item).slice(0, 100) : [] }
function safeHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const allowed = new Set(['message-id', 'in-reply-to', 'references', 'auto-submitted', 'precedence'])
  const result: Record<string, string> = {}
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const normalized = name.trim().toLowerCase()
    const header = string(raw, 2_000)
    if (allowed.has(normalized) && header) result[normalized] = header
  }
  return Object.keys(result).length ? result : undefined
}

export function normalizeInboundProviderPayload(provider: MailboxProviderType, payload: unknown, mailboxConnectionId: string | null): NormalizedInboundProviderMessage {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Malformed inbound provider payload')
  const row = payload as Record<string, unknown>
  const providerMessageId = string(row.providerMessageId ?? row.id, 500)
  const from = string(row.from, 320)
  if (!providerMessageId || !from || !from.includes('@')) throw new Error('Malformed inbound provider payload')
  const receivedAt = string(row.receivedAt, 100)
  if (receivedAt && !Number.isFinite(Date.parse(receivedAt))) throw new Error('Malformed inbound provider timestamp')
  return { provider, providerMessageId, mailboxConnectionId, from, to: addresses(row.to), subject: string(row.subject, 998), receivedAt, threadId: string(row.threadId), messageId: string(row.messageId), inReplyTo: addresses(row.inReplyTo), references: addresses(row.references), headers: safeHeaders(row.headers), textPreview: string(row.textPreview, 500) }
}
