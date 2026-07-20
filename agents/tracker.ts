import { createServiceClient } from '@/lib/supabase/server'
import { sendEmail, getReceivedEmailHeaders } from '@/lib/resend'
import { getDashboardMetrics, getLeadName, logAnalyticsMetrics } from '@/lib/analytics'
import { logger } from '@/lib/logger'

// supabaseOverride exists purely for tests to inject a fake client — every
// production call site omits it and gets the real service-role client.
export async function handleEmailReply(
  leadId: string,
  supabaseOverride?: ReturnType<typeof createServiceClient>
): Promise<void> {
  const supabase = supabaseOverride ?? createServiceClient()

  const { data: lead } = await supabase
    .from('leads')
    .select('id, business_name, status')
    .eq('id', leadId)
    .single()

  if (!lead) return

  // Only advance status on the lead's first reply. A lead that has already
  // moved past 'contacted' (negotiating, closed, etc.) must not be regressed
  // back to 'replied' by a second reply on the same thread, or by duplicate
  // webhook delivery of the same reply event.
  if (lead.status === 'contacted') {
    await supabase.from('leads').update({ status: 'replied' }).eq('id', leadId)
  }

  await supabase
    .from('emails')
    .update({ replied_at: new Date().toISOString() })
    .eq('lead_id', leadId)
    .eq('type', 'initial_pitch')

  await supabase.from('activity_log').insert({
    event_type: 'reply_received',
    lead_id: leadId,
    description: `Reply received from ${lead.business_name}`,
    metadata: {},
  })

  logger.info('tracker', `Reply received from ${lead.business_name}`, { lead_id: leadId })
}

// Matches an inbound email.received webhook event to a lead and, if found,
// routes it through handleEmailReply. The webhook payload itself only carries
// email_id/from/to/subject/message_id — not In-Reply-To — so this fetches the
// full raw headers via Resend's Inbound Email API to find which of our sent
// Message-IDs the reply is answering. Falls back to matching the sender's
// address against leads.email if no header match is found (e.g. the
// recipient composed a new email instead of hitting reply).
//
// Requires Resend's Inbound Email feature to be provisioned on a receiving
// domain — see src/app/api/webhooks/resend/route.ts for details. Until that
// is done, email.received is never sent by Resend and this function is never
// invoked; it does not itself require any further setup once that is in place.
export async function handleInboundEmail(
  params: { emailId: string; from: string },
  supabaseOverride?: ReturnType<typeof createServiceClient>,
  fetchHeaders: typeof getReceivedEmailHeaders = getReceivedEmailHeaders
): Promise<void> {
  const supabase = supabaseOverride ?? createServiceClient()

  const headers = await fetchHeaders(params.emailId)
  const inReplyTo = headers
    ? Object.entries(headers).find(([key]) => key.toLowerCase() === 'in-reply-to')?.[1]?.trim()
    : null

  let leadId: string | null = null

  if (inReplyTo) {
    const { data: matchedEmail } = await supabase
      .from('emails')
      .select('lead_id')
      .eq('message_id', inReplyTo)
      .limit(1)
      .maybeSingle()
    leadId = matchedEmail?.lead_id ?? null
  }

  if (!leadId && params.from) {
    const { data: matchedLead } = await supabase
      .from('leads')
      .select('id')
      .ilike('email', params.from)
      .limit(1)
      .maybeSingle()
    leadId = matchedLead?.id ?? null
  }

  if (!leadId) {
    logger.info('tracker', 'Inbound email received but no matching lead found', {
      email_id: params.emailId,
      from:     params.from,
      had_in_reply_to: !!inReplyTo,
    })
    return
  }

  await handleEmailReply(leadId, supabaseOverride)
}

export async function handleEmailBounce(
  leadId: string,
  resendId: string,
  supabaseOverride?: ReturnType<typeof createServiceClient>
): Promise<void> {
  const supabase = supabaseOverride ?? createServiceClient()

  const { error: updateErr } = await supabase
    .from('emails')
    .update({ status: 'bounced' })
    .eq('resend_id', resendId)

  if (updateErr) {
    logger.error('tracker', 'Failed to mark email bounced', {
      lead_id:   leadId,
      resend_id: resendId,
      error:     updateErr.message,
    })
  }

  await supabase.from('activity_log').insert({
    event_type: 'email_bounced',
    lead_id: leadId,
    description: `Email bounced for lead ${leadId}`,
    metadata: { resend_id: resendId },
  })

  logger.info('tracker', 'Email bounced', { lead_id: leadId, resend_id: resendId })
}

export async function sendDailyDigest(): Promise<void> {
  const supabase = createServiceClient()

  try {
    const { data: digestSetting } = await supabase.from('settings').select('value').eq('key', 'digest_email').single()
    const digestEmail = digestSetting?.value ?? 'hello@aussieventure.com'

    const { data: appUrlSetting } = await supabase.from('settings').select('value').eq('key', 'app_url').single()
    const appUrl = appUrlSetting?.value ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

    const now = new Date()
    const oneWeekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString()
    const metrics = await getDashboardMetrics(supabase, now)

    logAnalyticsMetrics('[DIGEST_METRICS]', {
      range: metrics.todayEmailStats.range,
      totalEmails: metrics.todayEmailStats.totalSent,
      followups: metrics.followupStats.sentToday,
      replies: metrics.replyStats.repliesToday,
    })

    const recentEmails = metrics.todayEmailStats.emails
    const initialEmails = recentEmails.filter((email) => email.type === 'initial_pitch')
    const followUpEmails = recentEmails.filter((email) => email.type !== 'initial_pitch')

    const { data: newReplies } = await supabase
      .from('emails')
      .select('id, lead_id, replied_at, leads(business_name)')
      .not('replied_at', 'is', null)
      .gte('replied_at', metrics.todayEmailStats.range.start)
      .lt('replied_at', metrics.todayEmailStats.range.end)

    const { data: dealsThisWeek } = await supabase
      .from('deals')
      .select('lead_id, deal_value, leads(business_name)')
      .gte('closed_at', oneWeekAgo)

    const totalDealValue = (dealsThisWeek ?? []).reduce((sum, deal) => sum + (deal.deal_value ?? 0), 0)

    const { data: agentErrors } = await supabase
      .from('activity_log')
      .select('description, metadata, created_at')
      .eq('event_type', 'agent_error')
      .gte('created_at', metrics.todayEmailStats.range.start)
      .lt('created_at', metrics.todayEmailStats.range.end)
      .order('created_at', { ascending: true })

    const date = now.toLocaleDateString('en-AU', {
      timeZone: metrics.todayEmailStats.range.timezone,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })

    const emailList = initialEmails.map((email) => `- ${getLeadName(email)}`).join('\n')
    const followUpList = followUpEmails
      .map((email) => `- ${getLeadName(email)} (${email.type.replace('_', ' ')})`)
      .join('\n')

    const repliesList = (newReplies ?? [])
      .map((reply) => {
        const lead = reply.leads as unknown as { business_name: string } | { business_name: string }[] | null
        const businessName = Array.isArray(lead) ? lead[0]?.business_name : lead?.business_name
        return `- ${businessName ?? 'Unknown'}`
      })
      .join('\n')

    const dealsList = (dealsThisWeek ?? [])
      .map((deal) => {
        const lead = deal.leads as unknown as { business_name: string } | null
        return `- ${lead?.business_name ?? 'Unknown'} ($${deal.deal_value})`
      })
      .join('\n')

    const errorsList = (agentErrors ?? [])
      .map((error) => {
        const meta = error.metadata as { agent?: string; error?: string } | null
        const agent = meta?.agent ?? 'unknown'
        const errorMsg = meta?.error ?? error.description ?? ''
        const time = new Date(error.created_at).toLocaleTimeString('en-AU', {
          timeZone: metrics.todayEmailStats.range.timezone,
          hour: '2-digit',
          minute: '2-digit',
        })
        return `- ${agent} agent failed at ${time}: ${errorMsg.slice(0, 100)}`
      })
      .join('\n')

    const body = `Morning Owais!

Here's what happened today:

TOTAL EMAILS SENT TODAY (${metrics.todayEmailStats.totalSent})

INITIAL EMAILS SENT (${initialEmails.length})
${emailList || 'None'}

FOLLOW-UPS SENT (${followUpEmails.length})
${followUpList || 'None'}

NEW REPLIES (${metrics.replyStats.repliesToday})
${repliesList || 'None'}

DEALS CLOSED THIS WEEK (${(dealsThisWeek ?? []).length})
${dealsList || 'None'}
Total this week: $${totalDealValue.toFixed(2)}

${(agentErrors ?? []).length > 0 ? `\nPIPELINE ERRORS (${(agentErrors ?? []).length})\n${errorsList}\n` : ''}View Dashboard: ${appUrl}/dashboard`

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0f1117; color: #e2e8f0;">
<h2 style="color: #38bdf8;">ReachAgent: Daily Summary</h2>
<p style="color: #94a3b8;">${date}</p>
<p>Morning Owais!</p>
<p>Here's what happened today:</p>

<h3 style="color: #38bdf8;">Total Emails Sent Today (${metrics.todayEmailStats.totalSent})</h3>

<h3 style="color: #38bdf8;">Initial Emails Sent (${initialEmails.length})</h3>
<p style="white-space: pre-line;">${emailList || 'None'}</p>

<h3 style="color: #a78bfa;">Follow-ups Sent (${followUpEmails.length})</h3>
<p style="white-space: pre-line;">${followUpList || 'None'}</p>

<h3 style="color: #4ade80;">New Replies (${metrics.replyStats.repliesToday})</h3>
<p style="white-space: pre-line;">${repliesList || 'None'}</p>

<h3 style="color: #fbbf24;">Deals Closed This Week (${(dealsThisWeek ?? []).length})</h3>
<p style="white-space: pre-line;">${dealsList || 'None'}</p>
<p><strong>Total this week: $${totalDealValue.toFixed(2)}</strong></p>

${(agentErrors ?? []).length > 0 ? `<h3 style="color: #f87171;">Pipeline Errors (${(agentErrors ?? []).length})</h3><p style="white-space: pre-line; color: #fca5a5;">${errorsList}</p>` : ''}
<p><a href="${appUrl}/dashboard" style="background: #38bdf8; color: #0f1117; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: bold;">View Dashboard</a></p>
</body>
</html>`

    await sendEmail({
      to: digestEmail,
      subject: `ReachAgent: Daily Summary ${date}`,
      html,
      text: body,
      leadId: 'digest',
    })

    await supabase.from('activity_log').insert({
      event_type: 'digest_sent',
      description: `Daily digest sent to ${digestEmail}`,
      metadata: {
        emails_sent: initialEmails.length,
        total_emails_sent: metrics.todayEmailStats.totalSent,
        follow_ups_sent: metrics.followupStats.sentToday,
        new_replies: metrics.replyStats.repliesToday,
        deals_this_week: (dealsThisWeek ?? []).length,
      },
    })

    logger.info('tracker', 'Daily digest sent', { to: digestEmail })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('tracker', 'Fatal error in sendDailyDigest', {
      error: message,
      stack: error instanceof Error ? error.stack : null,
    })
    await supabase.from('activity_log').insert({
      event_type: 'agent_error',
      description: `Agent failed: ${message}`,
      metadata: {
        agent: 'tracker',
        error: message,
        stack: error instanceof Error ? error.stack : null,
        timestamp: new Date().toISOString(),
      },
    })
    throw error
  }
}
