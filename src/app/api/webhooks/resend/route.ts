import { NextRequest, NextResponse } from 'next/server'
import type { WebhookEventPayload } from 'resend'
import { verifyResendWebhook } from '@/lib/webhook-verify'
import { handleInboundEmail, handleTerminalDeliveryFailure } from '../../../../../agents/tracker'
import { logger } from '@/lib/logger'

// ─── Reply detection prerequisite ───────────────────────────────────────────
// Resend has no "email.replied" event — replies are only observable via the
// Inbound Email feature's "email.received" event, which fires when a message
// arrives at a domain Resend has been configured to receive mail for (MX
// records pointed at Resend + an inbound route/address set up in the Resend
// dashboard). That is an account/DNS-level change outside this codebase; it
// is NOT something this file can turn on. Until it's provisioned, Resend
// simply never sends email.received and handleInboundEmail below is never
// invoked — replies will not be detected automatically.
//
// If aussieventure.com's MX already points elsewhere (e.g. Google Workspace)
// for real inbound mail, enabling Resend Inbound on the same domain would
// conflict with that — a dedicated receiving subdomain (e.g.
// reply.aussieventure.com) with its own MX records is the safe way to add
// this without disrupting existing mail. Until this is set up, the interim
// safety net is the existing manual reply/status controls in the dashboard.
//
// Terminal delivery handling (email.bounced, email.failed, email.suppressed)
// has no such prerequisite and is active once signature verification passes.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.text()

  let event: WebhookEventPayload
  try {
    event = verifyResendWebhook(body, request.headers, process.env.RESEND_WEBHOOK_SECRET)
  } catch (error) {
    logger.error('webhook', 'Resend webhook signature verification failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  try {
    switch (event.type) {
      case 'email.bounced':
      case 'email.failed':
      case 'email.suppressed': {
        const providerReason = event.type === 'email.bounced'
          ? event.data.bounce
          : event.type === 'email.failed'
            ? event.data.failed
            : event.data.suppressed
        const handled = await handleTerminalDeliveryFailure({
          taggedLeadId: event.data.tags?.['lead_id'],
          resendId: event.data.email_id,
          eventType: event.type,
          recipient: event.data.to?.[0],
          providerReason,
        })
        // Returning 500 asks Resend to retry a valid event that raced the
        // post-send database write, rather than acknowledging and losing it.
        if (!handled) throw new Error(`No email row found for Resend id ${event.data.email_id}`)
        break
      }

      case 'email.received': {
        await handleInboundEmail({
          emailId: event.data.email_id,
          from: event.data.from,
          subject: event.data.subject,
        })
        break
      }

      default:
        // Successful/non-terminal events are accepted but do not replace an
        // existing terminal status. Reply handling remains email.received.
        break
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    logger.error('webhook', 'Error handling Resend webhook event', {
      type:  event.type,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
