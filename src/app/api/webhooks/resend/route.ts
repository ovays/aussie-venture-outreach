import { NextRequest, NextResponse } from 'next/server'
import type { WebhookEventPayload } from 'resend'
import { verifyResendWebhook } from '@/lib/webhook-verify'
import { handleEmailBounce, handleInboundEmail } from '../../../../../agents/tracker'
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
// Bounce handling (email.bounced) has no such prerequisite and is fully
// functional as soon as signature verification passes.
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
      case 'email.bounced': {
        const leadId = event.data.tags?.['lead_id']
        if (leadId) {
          await handleEmailBounce(leadId, event.data.email_id)
        }
        break
      }

      case 'email.received': {
        await handleInboundEmail({ emailId: event.data.email_id, from: event.data.from })
        break
      }

      default:
        // All other event types (email.sent, delivered, opened, clicked,
        // complained, etc.) are accepted but currently unhandled.
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
