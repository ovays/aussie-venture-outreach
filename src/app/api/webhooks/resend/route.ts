import { NextRequest, NextResponse } from 'next/server'
import { createHmac } from 'crypto'
import { handleEmailReply, handleEmailBounce } from '../../../../../agents/tracker'

interface ResendWebhookEvent {
  type: string
  data: {
    email_id?: string
    tags?: Array<{ name: string; value: string }>
    bounce?: { message: string }
  }
}

function verifyWebhookSignature(body: string, signature: string): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) return false

  const hmac = createHmac('sha256', secret)
  hmac.update(body)
  const computed = hmac.digest('hex')
  return computed === signature
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.text()
    const signature = request.headers.get('svix-signature') ?? ''

    if (!verifyWebhookSignature(body, signature)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const event: ResendWebhookEvent = JSON.parse(body)
    const tags = event.data.tags ?? []
    const leadTag = tags.find((t) => t.name === 'lead_id')
    const leadId = leadTag?.value

    if (!leadId) {
      return NextResponse.json({ ok: true })
    }

    if (event.type === 'email.replied') {
      await handleEmailReply(leadId)
    }

    if (event.type === 'email.bounced' && event.data.email_id) {
      await handleEmailBounce(leadId, event.data.email_id)
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('Webhook error:', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
