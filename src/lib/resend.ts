import { Resend } from 'resend'
import { randomUUID } from 'crypto'
import { withRetry } from './retry'
import { assertOutreachSendEnabled } from './side-effect-safety'
import { observability } from './observability/service'

const MESSAGE_ID_DOMAIN = 'aussieventure.com'

function getResend(): Resend {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY is not set')
  return new Resend(key)
}

// Builds the RFC 5322 Message-ID / In-Reply-To / References headers for an
// outbound send. We generate our own Message-ID (rather than relying on
// whatever Resend sets internally) so we can store it before the send
// resolves and reference it deterministically from a later follow-up.
// Pure/no network — exported so tests can verify header shape directly.
export function buildThreadingHeaders(references?: string[], stableMessageId?: string): {
  messageId: string
  headers: Record<string, string>
} {
  const messageId = stableMessageId ?? `<${randomUUID()}@${MESSAGE_ID_DOMAIN}>`
  const headers: Record<string, string> = { 'Message-ID': messageId }

  if (references?.length) {
    headers['In-Reply-To'] = references[references.length - 1]
    headers['References'] = references.join(' ')
  }

  return { messageId, headers }
}

export async function sendEmail(params: {
  to: string
  subject: string
  html: string
  text: string
  leadId: string
  /** Message-IDs of every prior email in this thread, oldest first. Set this
   *  to thread the send as a reply (In-Reply-To/References). Omit for a new
   *  thread (initial pitch, reactivation). */
  references?: string[]
  /** Stable across worker retries. Resend deduplicates requests with this key. */
  idempotencyKey?: string
  /** Stable RFC Message-ID paired with idempotencyKey for durable email intents. */
  messageId?: string
  /** Durable email intent and phase are correlation only; content is never logged. */
  emailIntentId?: string
  phase?: string
}): Promise<{ id: string; messageId: string } | null> {
  assertOutreachSendEnabled('Resend email delivery')
  // Generated once, outside the retry closure: withRetry only retries when
  // the Resend call *throws* (network timeout/reset) — the case where the
  // request may have already reached Resend and been accepted before the
  // response was lost. Regenerating messageId per attempt would mean a
  // successful-but-unconfirmed first attempt and a successful retry produce
  // two really-delivered emails with two different Message-IDs, with no way
  // to tell from the single row we'd persist that a duplicate happened.
  // Passing the same idempotencyKey on every attempt instead lets Resend
  // itself dedupe: a retried request with a key it already processed returns
  // the original result rather than sending again.
  const { messageId, headers } = buildThreadingHeaders(params.references, params.messageId)
  const idempotencyKey = params.idempotencyKey ?? messageId
  const telemetry = observability()
  const stepId = await telemetry.startWorkflowStep({
    stepName: 'resend_send', stepType: 'provider_request', leadId: params.leadId,
    provider: 'resend', inputSummary: { email_intent_id: params.emailIntentId ?? null, phase: params.phase ?? null },
  })
  let retryCount = 0

  try {
    const result = await (async () => {
      return await withRetry(async () => {
      const resend = getResend()

      const { data, error } = await resend.emails.send({
        from: 'Owais | Aussie Venture <hello@aussieventure.com>',
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        tags: params.leadId !== 'digest' ? [{ name: 'lead_id', value: params.leadId }] : [],
        headers,
      }, { idempotencyKey })

      if (error) {
        console.error('[resend] API returned error:', JSON.stringify(error, null, 2))
        return null
      }

      return data ? { id: data.id, messageId } : null
      }, { maxAttempts: 3, baseDelayMs: 1000, onRetry: () => { retryCount++ } })
    })()
    if (result) {
      await telemetry.completeWorkflowStep(stepId, {
        provider: 'resend', externalRequestId: result.id, externalMessageId: result.messageId,
        responseStatus: 'accepted', retryCount,
        outputSummary: { email_intent_id: params.emailIntentId ?? null, phase: params.phase ?? null, outcome: 'accepted' },
      })
    } else {
      await telemetry.failWorkflowStep(stepId, new Error('Resend provider returned no accepted message'), {
        email_intent_id: params.emailIntentId ?? null, phase: params.phase ?? null, retry_count: retryCount, outcome: 'failed', retryable: false,
      })
    }
    return result
  } catch (error) {
    await telemetry.failWorkflowStep(stepId, error, {
      email_intent_id: params.emailIntentId ?? null, phase: params.phase ?? null, retry_count: retryCount, outcome: 'uncertain', retryable: true,
    })
    console.error('[resend] Exception thrown:', error)
    throw new UncertainEmailDeliveryError('Resend delivery outcome is uncertain', { cause: error })
  }
}

/** A transport failure can occur after the provider accepted the request. */
export class UncertainEmailDeliveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UncertainEmailDeliveryError'
  }
}

// Fetches the full raw headers of an inbound email via Resend's Inbound Email
// API (GET /emails/receiving/{id}). The email.received webhook payload itself
// only carries email_id/from/to/subject/message_id — not In-Reply-To or
// References — so matching a reply back to its thread requires this follow-up
// call. Requires Resend's Inbound Email feature to be provisioned on a
// receiving domain; see the webhook route for details.
export async function getReceivedEmailHeaders(emailId: string): Promise<Record<string, string> | null> {
  try {
    const resend = getResend()
    const { data, error } = await resend.emails.receiving.get(emailId)
    if (error || !data) {
      console.error('[resend] Failed to fetch received email headers:', error ? JSON.stringify(error) : 'no data', { emailId })
      return null
    }
    return data.headers ?? null
  } catch (error) {
    console.error('[resend] Exception fetching received email headers:', error, { emailId })
    return null
  }
}
