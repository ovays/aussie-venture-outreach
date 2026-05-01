import { Resend } from 'resend'

function getResend(): Resend {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY is not set')
  return new Resend(key)
}

export async function sendEmail(params: {
  to: string
  subject: string
  html: string
  text: string
  leadId: string
}): Promise<{ id: string } | null> {
  if (params.leadId === 'digest' || !params.to || params.to === 'digest') {
    // Allow digest sends even without a real lead ID
  }

  try {
    const resend = getResend()
    const result = await resend.emails.send({
      from: 'Owais | Aussie Venture <hello@aussieventure.com>',
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      tags: params.leadId !== 'digest' ? [{ name: 'lead_id', value: params.leadId }] : [],
    })
    return result.data
  } catch (error) {
    console.error('Resend error:', error)
    return null
  }
}
