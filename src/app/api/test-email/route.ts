import { NextRequest, NextResponse } from 'next/server'
import { writeOutreachEmail } from '@/lib/claude'
import { emailBodyToHtml } from '@/lib/utils'
import { Resend } from 'resend'
import { isAuthErrorResponse, requireApiAdmin } from '@/lib/auth'

const VISIT_ELIGIBLE = [
  'Halal Restaurants', 'Halal Cafes', 'Halal Bakeries / Dessert Shops',
  'Nail Salons', 'Hair Salons', 'Beauty / Lash Studios',
  'Spas / Massage Studios', 'Hotels / Resorts',
]

function getResend() {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY is not set')
  return new Resend(key)
}

function wrapInTemplate(innerHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:#0f1117;padding:20px 32px 16px;">
      <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">Aussie Venture</p>
      <p style="margin:4px 0 0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:1px;">Test Email</p>
    </div>
    <div style="padding:28px 32px 24px;">
      ${innerHtml}
    </div>
    <div style="background:#f8fafc;padding:14px 32px;border-top:1px solid #e5e7eb;">
      <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">Test send · Aussie Venture Outreach System · aussieventure.com</p>
    </div>
  </div>
</body>
</html>`
}

export async function POST(req: NextRequest) {
  const auth = await requireApiAdmin()
  if (isAuthErrorResponse(auth)) return auth

  try {
    const body = await req.json()
    const { action } = body

    if (action === 'generate') {
      const { business_name, category, city, suburb } = body

      if (!business_name || !category || !city || !suburb) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
      }

      const isSydney = city.toLowerCase() === 'sydney'
      const contentType = (isSydney && VISIT_ELIGIBLE.includes(category)) ? 'visit' : 'remote'

      const result = await writeOutreachEmail({
        business_name,
        category,
        suburb,
        city,
        website: '',
        description: '',
        services: '',
        content_type: contentType,
      })

      return NextResponse.json({
        subject: result.subject,
        body: result.body,
        content_type: contentType,
      })
    }

    if (action === 'send') {
      const { subject, body: emailBody } = body

      if (!subject || !emailBody) {
        return NextResponse.json({ error: 'Missing subject or body' }, { status: 400 })
      }

      const resend = getResend()
      const html = wrapInTemplate(emailBodyToHtml(emailBody))

      const result = await resend.emails.send({
        from: 'Owais | Aussie Venture <hello@aussieventure.com>',
        to: 'hello@aussieventure.com',
        subject: `[TEST] ${subject}`,
        html,
        text: emailBody,
      })

      if (result.error) {
        return NextResponse.json({ error: result.error.message }, { status: 500 })
      }

      return NextResponse.json({ id: result.data?.id })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
