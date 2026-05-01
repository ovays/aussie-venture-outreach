import { createServiceClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/resend'

export async function runSenderAgent(): Promise<{ sent: number; failed: number }> {
  const supabase = createServiceClient()

  const { data: systemSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'system_active')
    .single()

  console.log(`[sender] system_active = "${systemSetting?.value}"`)

  if (systemSetting?.value !== 'true') {
    console.log('[sender] System is paused - Sender agent skipped')
    return { sent: 0, failed: 0 }
  }

  const { data: limitSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'daily_email_limit')
    .single()

  const dailyLimit = parseInt(limitSetting?.value ?? '50', 10)
  console.log(`[sender] daily_email_limit = ${dailyLimit}`)

  // Diagnostic: count total pending_send emails before applying limit
  const { count: pendingCount } = await supabase
    .from('emails')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending_send')
  console.log(`[sender] emails with status=pending_send: ${pendingCount ?? 0}`)

  // Diagnostic: count leads with email_ready status
  const { count: emailReadyCount } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'email_ready')
  console.log(`[sender] leads with status=email_ready: ${emailReadyCount ?? 0}`)

  // Diagnostic: count email_ready leads that actually have an email address
  const { count: emailReadyWithEmail } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'email_ready')
    .not('email', 'is', null)
  console.log(`[sender] email_ready leads with a real email address: ${emailReadyWithEmail ?? 0}`)

  const { data: pendingEmails } = await supabase
    .from('emails')
    .select('*, leads(email, business_name)')
    .eq('status', 'pending_send')
    .limit(dailyLimit)

  console.log(`[sender] fetched ${pendingEmails?.length ?? 0} pending emails to process`)

  if (!pendingEmails?.length) {
    console.log('[sender] No pending emails to send — emails table has no pending_send rows')
    return { sent: 0, failed: 0 }
  }

  let sent = 0
  let failed = 0
  const total = pendingEmails.length

  for (let i = 0; i < pendingEmails.length; i++) {
    const emailRecord = pendingEmails[i]
    const lead = emailRecord.leads as { email: string | null; business_name: string } | null

    if (!lead?.email) {
      console.log(`[sender] #${i + 1}/${total} SKIP — no email address for lead_id=${emailRecord.lead_id}`)
      await supabase.from('emails').update({ status: 'failed' }).eq('id', emailRecord.id)
      failed++
      continue
    }

    console.log(`[sender] #${i + 1}/${total} Sending to: ${lead.email} (${lead.business_name}) subject: "${emailRecord.subject}"`)

    try {
      const result = await sendEmail({
        to: lead.email,
        subject: emailRecord.subject,
        html: emailRecord.body_html,
        text: emailRecord.body_text,
        leadId: emailRecord.lead_id,
      })

      if (result) {
        console.log(`[sender] #${i + 1}/${total} SUCCESS — resend_id=${result.id}`)

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
        console.error(`[sender] #${i + 1}/${total} FAILED — sendEmail returned null for ${lead.email} (Resend error logged above)`)

        await supabase.from('emails').update({ status: 'failed' }).eq('id', emailRecord.id)

        await supabase.from('activity_log').insert({
          event_type: 'email_failed',
          lead_id: emailRecord.lead_id,
          description: `Failed to send email to ${lead.business_name} (${lead.email})`,
          metadata: { to: lead.email, subject: emailRecord.subject },
        })

        failed++
      }
    } catch (error) {
      console.error(`[sender] #${i + 1}/${total} EXCEPTION for ${lead.email}:`, error)
      await supabase.from('emails').update({ status: 'failed' }).eq('id', emailRecord.id)
      await supabase.from('activity_log').insert({
        event_type: 'sender_error',
        lead_id: emailRecord.lead_id,
        description: `Exception sending to ${lead.business_name} (${lead.email})`,
        metadata: { error: String(error), to: lead.email },
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
