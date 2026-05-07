import { createServiceClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/resend'
import { textToHtml } from '@/lib/utils'
import { logger } from '@/lib/logger'

export async function runFollowUpAgent(): Promise<void> {
  const supabase = createServiceClient()

  try {
  const { data: systemSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'system_active')
    .single()

  if (systemSetting?.value !== 'true') {
    logger.info('followup', 'System paused - skipped')
    return
  }

  // Read timing settings
  const { data: settingsRows } = await supabase
    .from('settings')
    .select('key, value')
    .in('key', ['follow_up_1_days', 'follow_up_2_days', 'dead_lead_days'])

  const settings: Record<string, number> = {}
  for (const row of settingsRows ?? []) {
    settings[row.key] = parseInt(row.value, 10)
  }

  const followUp1Days = settings['follow_up_1_days'] ?? 7
  const followUp2Days = settings['follow_up_2_days'] ?? 14
  const deadLeadDays = settings['dead_lead_days'] ?? 21

  const { data: contactedLeads } = await supabase
    .from('leads')
    .select('*, emails(id, type, subject, sent_at)')
    .eq('status', 'contacted')

  if (!contactedLeads?.length) {
    logger.info('followup', 'No contacted leads to follow up')
    return
  }

  let followUp1Sent = 0
  let followUp2Sent = 0
  let markedDead = 0

  for (const lead of contactedLeads) {
    if (!lead.email) continue

    const emailsList = lead.emails as Array<{ id: string; type: string; subject: string; sent_at: string | null }>
    const initialEmail = emailsList?.find((e) => e.type === 'initial_pitch' && e.sent_at)
    if (!initialEmail?.sent_at) continue

    const daysSince = Math.floor(
      (Date.now() - new Date(initialEmail.sent_at).getTime()) / 86_400_000
    )

    const hasFollowUp1 = emailsList.some((e) => e.type === 'follow_up_1')
    const hasFollowUp2 = emailsList.some((e) => e.type === 'follow_up_2')

    // Mark dead
    if (daysSince >= deadLeadDays) {
      await supabase.from('leads').update({ status: 'dead' }).eq('id', lead.id)
      await supabase.from('activity_log').insert({
        event_type: 'lead_marked_dead',
        lead_id: lead.id,
        description: `Lead marked as dead: ${lead.business_name} (${daysSince} days no reply)`,
        metadata: { days_since: daysSince },
      })
      logger.info('followup', `Marked dead: ${lead.business_name}`, { daysSince })
      markedDead++
      continue
    }

    // Follow-up 2
    if (daysSince >= followUp2Days && !hasFollowUp2 && hasFollowUp1) {
      const body = `Hey ${lead.business_name},

Last message from me on this one. If you ever want to do a collab down the track, just email us at hello@aussieventure.com.

Cheers,
Owais
Aussie Venture`

      const subject = `Re: ${initialEmail.subject}`
      const html = textToHtml(body)

      const result = await sendEmail({
        to: lead.email,
        subject,
        html,
        text: body,
        leadId: lead.id,
      })

      const { data: emailRow } = await supabase.from('emails').insert({
        lead_id: lead.id,
        type: 'follow_up_2',
        subject,
        body_html: html,
        body_text: body,
        resend_id: result?.id ?? null,
        status: result ? 'sent' : 'failed',
        sent_at: result ? new Date().toISOString() : null,
      }).select().single()

      if (emailRow) {
        await supabase.from('follow_ups').insert({
          lead_id: lead.id,
          follow_up_number: 2,
          scheduled_at: new Date().toISOString(),
          sent_at: new Date().toISOString(),
          email_id: emailRow.id,
          status: 'sent',
        })
      }

      await supabase.from('activity_log').insert({
        event_type: 'follow_up_2_sent',
        lead_id: lead.id,
        description: `Follow-up 2 sent to ${lead.business_name}`,
        metadata: { days_since: daysSince },
      })

      logger.info('followup', `Follow-up 2 sent: ${lead.business_name}`, { daysSince })
      followUp2Sent++
      continue
    }

    // Follow-up 1
    if (daysSince >= followUp1Days && !hasFollowUp1) {
      const body = `Hey ${lead.business_name},

Bumping this in case my last email got buried. Would love to hear back when you get a chance.

Cheers,
Owais
Aussie Venture
hello@aussieventure.com`

      const subject = `Re: ${initialEmail.subject}`
      const html = textToHtml(body)

      const result = await sendEmail({
        to: lead.email,
        subject,
        html,
        text: body,
        leadId: lead.id,
      })

      const { data: emailRow } = await supabase.from('emails').insert({
        lead_id: lead.id,
        type: 'follow_up_1',
        subject,
        body_html: html,
        body_text: body,
        resend_id: result?.id ?? null,
        status: result ? 'sent' : 'failed',
        sent_at: result ? new Date().toISOString() : null,
      }).select().single()

      if (emailRow) {
        await supabase.from('follow_ups').insert({
          lead_id: lead.id,
          follow_up_number: 1,
          scheduled_at: new Date().toISOString(),
          sent_at: new Date().toISOString(),
          email_id: emailRow.id,
          status: 'sent',
        })
      }

      await supabase.from('activity_log').insert({
        event_type: 'follow_up_1_sent',
        lead_id: lead.id,
        description: `Follow-up 1 sent to ${lead.business_name}`,
        metadata: { days_since: daysSince },
      })

      logger.info('followup', `Follow-up 1 sent: ${lead.business_name}`, { daysSince })
      followUp1Sent++
    }
  }

  await supabase.from('activity_log').insert({
    event_type: 'followup_complete',
    description: `Follow-up agent done. FU1: ${followUp1Sent}, FU2: ${followUp2Sent}, Dead: ${markedDead}`,
    metadata: { follow_up_1_sent: followUp1Sent, follow_up_2_sent: followUp2Sent, marked_dead: markedDead },
  })

  logger.info('followup', 'Done', { followUp1Sent, followUp2Sent, markedDead })

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('followup', 'Fatal error', { error: message, stack: error instanceof Error ? error.stack : null })
    await supabase.from('activity_log').insert({
      event_type: 'agent_error',
      description: `Agent failed: ${message}`,
      metadata: {
        agent: 'followup',
        error: message,
        stack: error instanceof Error ? error.stack : null,
        timestamp: new Date().toISOString(),
      },
    })
    throw error
  }
}
