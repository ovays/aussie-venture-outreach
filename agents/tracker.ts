import { createServiceClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/resend'

export async function handleEmailReply(leadId: string): Promise<void> {
  const supabase = createServiceClient()

  const { data: lead } = await supabase
    .from('leads')
    .select('id, business_name, status')
    .eq('id', leadId)
    .single()

  if (!lead) return

  await supabase
    .from('leads')
    .update({ status: 'replied' })
    .eq('id', leadId)

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
}

export async function handleEmailBounce(leadId: string, emailId: string): Promise<void> {
  const supabase = createServiceClient()

  await supabase.from('emails').update({ status: 'bounced' }).eq('id', emailId)

  await supabase.from('activity_log').insert({
    event_type: 'email_bounced',
    lead_id: leadId,
    description: `Email bounced for lead ${leadId}`,
    metadata: { email_id: emailId },
  })
}

export async function sendDailyDigest(): Promise<void> {
  const supabase = createServiceClient()

  try {
  const { data: digestSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'digest_email')
    .single()

  const digestEmail = digestSetting?.value ?? 'hello@aussieventure.com'

  const { data: appUrlSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'app_url')
    .single()

  const appUrl = appUrlSetting?.value ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

  const now = new Date()
  const oneDayAgo = new Date(now.getTime() - 86_400_000).toISOString()
  const oneWeekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString()

  // Count emails sent in last 24h
  const { data: recentEmails } = await supabase
    .from('emails')
    .select('id, lead_id, type, leads(business_name)')
    .eq('status', 'sent')
    .gte('sent_at', oneDayAgo)

  const initialEmails = (recentEmails ?? []).filter((e) => e.type === 'initial_pitch')
  const followUpEmails = (recentEmails ?? []).filter((e) => e.type !== 'initial_pitch')

  // New replies in last 24h
  const { data: newReplies } = await supabase
    .from('leads')
    .select('id, business_name')
    .eq('status', 'replied')
    .gte('updated_at', oneDayAgo)

  // Deals closed this week
  const { data: dealsThisWeek } = await supabase
    .from('deals')
    .select('lead_id, deal_value, leads(business_name)')
    .gte('closed_at', oneWeekAgo)

  const totalDealValue = (dealsThisWeek ?? []).reduce(
    (sum, d) => sum + (d.deal_value ?? 0),
    0
  )

  // Pipeline errors in last 24h
  const { data: agentErrors } = await supabase
    .from('activity_log')
    .select('description, metadata, created_at')
    .eq('event_type', 'agent_error')
    .gte('created_at', oneDayAgo)
    .order('created_at', { ascending: true })

  const date = now.toLocaleDateString('en-AU', {
    timeZone: 'Australia/Sydney',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  const emailList = initialEmails
    .map((e) => {
      const lead = e.leads as unknown as { business_name: string } | null
      return `• ${lead?.business_name ?? 'Unknown'}`
    })
    .join('\n')

  const followUpList = followUpEmails
    .map((e) => {
      const lead = e.leads as unknown as { business_name: string } | null
      return `• ${lead?.business_name ?? 'Unknown'} (${e.type.replace('_', ' ')})`
    })
    .join('\n')

  const repliesList = (newReplies ?? []).map((r) => `• ${r.business_name}`).join('\n')

  const dealsList = (dealsThisWeek ?? [])
    .map((d) => {
      const lead = d.leads as unknown as { business_name: string } | null
      return `• ${lead?.business_name ?? 'Unknown'} ($${d.deal_value})`
    })
    .join('\n')

  const errorsList = (agentErrors ?? [])
    .map((e) => {
      const meta = e.metadata as { agent?: string; error?: string } | null
      const agent = meta?.agent ?? 'unknown'
      const errorMsg = meta?.error ?? e.description ?? ''
      const time = new Date(e.created_at).toLocaleTimeString('en-AU', {
        timeZone: 'Australia/Sydney',
        hour: '2-digit',
        minute: '2-digit',
      })
      return `• ${agent} agent failed at ${time} — ${errorMsg.slice(0, 100)}`
    })
    .join('\n')

  const body = `Morning Owais!

Here's what happened in the last 24 hours:

EMAILS SENT (${initialEmails.length})
${emailList || 'None'}

FOLLOW-UPS SENT (${followUpEmails.length})
${followUpList || 'None'}

NEW REPLIES (${(newReplies ?? []).length})
${repliesList || 'None'}

DEALS CLOSED THIS WEEK (${(dealsThisWeek ?? []).length})
${dealsList || 'None'}
Total this week: $${totalDealValue.toFixed(2)}

${(agentErrors ?? []).length > 0 ? `\n🚨 PIPELINE ERRORS (${(agentErrors ?? []).length})\n${errorsList}\n` : ''}View Dashboard: ${appUrl}/dashboard`

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #0f1117; color: #e2e8f0;">
<h2 style="color: #38bdf8;">Aussie Venture Outreach: Daily Summary</h2>
<p style="color: #94a3b8;">${date}</p>
<p>Morning Owais!</p>
<p>Here's what happened in the last 24 hours:</p>

<h3 style="color: #38bdf8;">📧 Emails Sent (${initialEmails.length})</h3>
<p style="white-space: pre-line;">${emailList || 'None'}</p>

<h3 style="color: #a78bfa;">📬 Follow-ups Sent (${followUpEmails.length})</h3>
<p style="white-space: pre-line;">${followUpList || 'None'}</p>

<h3 style="color: #4ade80;">🔥 New Replies (${(newReplies ?? []).length})</h3>
<p style="white-space: pre-line;">${repliesList || 'None'}</p>

<h3 style="color: #fbbf24;">✅ Deals Closed This Week (${(dealsThisWeek ?? []).length})</h3>
<p style="white-space: pre-line;">${dealsList || 'None'}</p>
<p><strong>Total this week: $${totalDealValue.toFixed(2)}</strong></p>

${(agentErrors ?? []).length > 0 ? `<h3 style="color: #f87171;">🚨 Pipeline Errors (${(agentErrors ?? []).length})</h3><p style="white-space: pre-line; color: #fca5a5;">${errorsList}</p>` : ''}
<p><a href="${appUrl}/dashboard" style="background: #38bdf8; color: #0f1117; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: bold;">View Dashboard →</a></p>
</body>
</html>`

  await sendEmail({
    to: digestEmail,
    subject: `Aussie Venture Outreach: Daily Summary ${date}`,
    html,
    text: body,
    leadId: 'digest',
  })

  await supabase.from('activity_log').insert({
    event_type: 'digest_sent',
    description: `Daily digest sent to ${digestEmail}`,
    metadata: {
      emails_sent: initialEmails.length,
      follow_ups_sent: followUpEmails.length,
      new_replies: (newReplies ?? []).length,
      deals_this_week: (dealsThisWeek ?? []).length,
    },
  })

  console.log('Daily digest sent')

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[tracker] Fatal error in sendDailyDigest:', error)
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
