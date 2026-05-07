import { Resend } from 'resend'
import { withRetry } from './retry'

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
  try {
    return await withRetry(async () => {
      const resend = getResend()
      const { data, error } = await resend.emails.send({
        from: 'Owais | Aussie Venture <hello@aussieventure.com>',
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        tags: params.leadId !== 'digest' ? [{ name: 'lead_id', value: params.leadId }] : [],
      })

      if (error) {
        console.error('[resend] API returned error:', JSON.stringify(error, null, 2))
        return null
      }

      return data
    }, { maxAttempts: 3, baseDelayMs: 1000 })
  } catch (error) {
    console.error('[resend] Exception thrown:', error)
    return null
  }
}
