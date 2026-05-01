import { createServiceClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/resend'

export async function runSenderAgent(): Promise<{ sent: number; failed: number }> {
  const supabase = createServiceClient()

  const { data: systemSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'system_active')
    .single()

  if (systemSetting?.value !== 'true') {
    console.log('System is paused - Sender agent skipped')
    return { sent: 0, failed: 0 }
  }

  const { data: limitSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'daily_email_limit')
    .single()

  const dailyLimit = parseInt(limitSetting?.value ?? '50', 10)

  const { data: pendingEmails } = await supabase
    .from('emails')
    .select('*, leads(email, business_name)')
    .eq('status', 'pending_send')
    .limit(dailyLimit)

  if (!pendingEmails?.length) {
    console.log('No pending emails to send')
    return { sent: 0, failed: 0 }
  }

  let sent = 0
  let failed = 0

  for (const emailRecord of pendingEmails) {
    const lead = emailRecord.leads as { email: string | null; business_name: string } | null

    if (!lead?.email) {
      await supabase.from('emails').update({ status: 'failed' }).eq('id', emailRecord.id)
      failed++
      continue
    }

    try {
      const result = await sendEmail({
        to: lead.email,
        subject: emailRecord.subject,
        html: emailRecord.body_html,
        text: emailRecord.body_text,
        leadId: emailRecord.lead_id,
      })

      if (result) {
        await supabase.from('emails').update({
          status: 'sent',
          resend_id: result.id,
          sent_at: new Date().toISOString(),
        }).eq('id', emailRecord.id)

        await supabase.from('leads').update({ status: 'contacted' }).eq('id', emailRecord.lead_id)

        await supabase.from('activity_log').insert({
          event_type: 'email_sent',
          lead_id: emailRecord.lead_id,
          description: `Email sent to ${lead.business_name} (${lead.email})`,
          metadata: { resend_id: result.id, subject: emailRecord.subject },
        })

        sent++
      } else {
        await supabase.from('emails').update({ status: 'failed' }).eq('id', emailRecord.id)

        await supabase.from('activity_log').insert({
          event_type: 'email_failed',
          lead_id: emailRecord.lead_id,
          description: `Failed to send email to ${lead.business_name}`,
          metadata: {},
        })

        failed++
      }
    } catch (error) {
      await supabase.from('emails').update({ status: 'failed' }).eq('id', emailRecord.id)
      await supabase.from('activity_log').insert({
        event_type: 'sender_error',
        lead_id: emailRecord.lead_id,
        description: `Error sending to ${lead.business_name}`,
        metadata: { error: String(error) },
      })
      failed++
    }
  }

  await supabase.from('activity_log').insert({
    event_type: 'sender_complete',
    description: `Sender agent completed - ${sent} sent, ${failed} failed`,
    metadata: { sent, failed },
  })

  console.log(`Sender agent done - ${sent} sent, ${failed} failed`)
  return { sent, failed }
}
