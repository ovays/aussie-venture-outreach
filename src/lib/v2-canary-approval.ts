import { createHash } from 'node:crypto'

export const V2_CANARY_SENDER_IDENTITY = 'Owais | Aussie Venture <hello@aussieventure.com>'
export const V2_CANARY_MESSAGE_ID_DOMAIN = 'aussieventure.com'

export interface CanaryContentEnvelope {
  recipient: string
  sender: string
  subject: string
  html: string
  text: string
  intentId: string
  phase: string
}

export function hashCanaryContent(envelope: CanaryContentEnvelope): string {
  const canonical = JSON.stringify([
    envelope.recipient,
    envelope.sender,
    envelope.subject,
    envelope.html,
    envelope.text,
    envelope.intentId,
    envelope.phase,
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

export function recipientFingerprint(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase() ?? ''
  if (!normalized) return null
  return createHash('sha256').update(normalized).digest('hex')
}

export function redactEmailPreview(email: string | null | undefined): string {
  const normalized = email?.trim().toLowerCase() ?? ''
  if (!normalized) return '<missing>'
  const at = normalized.lastIndexOf('@')
  const local = at >= 0 ? normalized.slice(0, at) : normalized
  const domain = at >= 0 ? normalized.slice(at) : ''
  const keep = Math.min(2, local.length)
  return `${local.slice(0, keep)}${'*'.repeat(Math.max(3, local.length - keep))}${domain}`
}

export interface CanaryApprovalBinding {
  leadId: string
  recipientFingerprint: string | null
  contentHash: string
  intentId: string
  sender: string
}

/** Requires operator approval bound to lead, recipient, content hash, intent, and sender. */
export function assertCanaryOperatorApproval(
  binding: CanaryApprovalBinding,
  env: Record<string, string | undefined> = process.env,
): { reference: string } {
  const token = env.V2_CANARY_APPROVAL_TOKEN?.trim()
  const approvedHash = env.V2_CANARY_APPROVED_CONTENT_HASH?.trim()
  const reference = env.V2_CANARY_APPROVAL_REFERENCE?.trim()
  if (!token) throw new Error('V2 canary execution requires V2_CANARY_APPROVAL_TOKEN.')
  if (!approvedHash) throw new Error('V2 canary execution requires V2_CANARY_APPROVED_CONTENT_HASH.')
  if (!reference) throw new Error('V2 canary execution requires V2_CANARY_APPROVAL_REFERENCE.')
  if (approvedHash !== binding.contentHash) {
    throw new Error('V2 canary content hash differs from the approved preview; send blocked.')
  }
  return { reference }
}
