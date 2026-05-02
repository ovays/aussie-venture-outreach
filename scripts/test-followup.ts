import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { sendEmail } from '../src/lib/resend'

function textToHtml(text: string): string {
  return text
    .split('\n')
    .map((line) => `<p>${line || '&nbsp;'}</p>`)
    .join('')
}

async function run() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // 1. Find one lead with status = 'contacted'
  const { data: lead, error } = await supabase
    .from('leads')
    .select('*, emails(id, type, subject, sent_at)')
    .eq('status', 'contacted')
    .limit(1)
    .single()

  if (error || !lead) {
    console.log('No contacted leads found in database.')
    console.log('Error:', error?.message ?? 'none returned')
    return
  }

  const emails = lead.emails as Array<{ id: string; type: string; subject: string; sent_at: string | null }>
  const initialEmail = emails?.find((e) => e.type === 'initial_pitch')

  console.log('=== Lead found ===')
  console.log(`Business : ${lead.business_name}`)
  console.log(`Real email: ${lead.email}`)
  console.log(`Status   : ${lead.status}`)
  console.log(`Category : ${lead.category_name}`)
  console.log(`Initial email sent: ${initialEmail?.sent_at ?? '(no initial email record)'}`)

  // 2. Pretend it was contacted 8 days ago — bypass the 7-day check by ignoring daysSince
  console.log('\n[bypass] Treating lead as contacted 8 days ago — skipping 7-day guard')

  // 3. Build follow-up 1 email (same body as followup.ts)
  const originalSubject = initialEmail?.subject ?? `Partnership Opportunity — ${lead.business_name}`
  const subject = `Re: ${originalSubject}`

  const body = `Hey ${lead.business_name},

Bumping this in case my last email got buried. Would love to hear back when you get a chance.

Cheers,
Owais
Aussie Venture
hello@aussieventure.com`

  const html = textToHtml(body)

  console.log('\n=== Follow-up email ===')
  console.log(`Subject: ${subject}`)
  console.log(`\nBody:\n${body}`)

  // 4. Send to hello@aussieventure.com — NOT the real business
  console.log('\nSending to hello@aussieventure.com (test — NOT real business)...')
  const result = await sendEmail({
    to: 'hello@aussieventure.com',
    subject,
    html,
    text: body,
    leadId: lead.id,
  })

  // 5. Log result
  if (result) {
    console.log(`\nFollow-up test email sent to hello@aussieventure.com`)
    console.log(`Resend ID: ${result.id}`)
  } else {
    console.log('\nSend failed — check RESEND_API_KEY and Resend logs')
  }
}

run()
