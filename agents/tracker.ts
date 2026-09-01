import { createServiceClient } from '@/lib/supabase/server'
import { sendEmail, getReceivedEmailHeaders } from '@/lib/resend'
import { getDashboardMetrics, getLeadName, logAnalyticsMetrics } from '@/lib/analytics'
import { logger } from '@/lib/logger'
import {
  isTerminalDeliveryStatus,
  normalizeDeliveryEmail,
  TERMINAL_RESEND_EVENTS,
  type TerminalResendEvent,
} from '@/lib/delivery-suppression'

// supabaseOverride exists purely for tests to inject a fake client — every
// production call site omits it and gets the real service-role client.
export async function handleEmailReply(
  leadId: string,
  supabaseOverride?: ReturnType<typeof createServiceClient>,
  matchedEmailId?: string,
  repliedAt?: string,
  inboundReceiptId?: string,
): Promise<void> {
  const supabase = supabaseOverride ?? createServiceClient()

  const { data: lead } = await supabase
    .from('leads')
    .select('id, business_name, status')
    .eq('id', leadId)
    .single()

  if (!lead) return

  // Advance outreach/no-response states, including a genuinely late reply
  // from a lead already marked dead. Never regress active-deal or closed
  // states. The status predicate also prevents a concurrent manual status
  // change between this read and update from being overwritten.
  if (lead.status === 'contacted' || lead.status === 'dead') {
    await supabase
      .from('leads')
      .update({ status: 'replied' })
      .eq('id', leadId)
      .eq('status', lead.status)
  }

  let replyUpdate = supabase
    .from('emails')
    .update({ replied_at: repliedAt ?? new Date().toISOString() })
    .eq('lead_id', leadId)
    .is('replied_at', null)

  // When In-Reply-To identified a specific outbound message, attribute the
  // reply to that row. Sender-address fallback has no thread identifier, so
  // retain the existing initial-pitch attribution in that case.
  replyUpdate = matchedEmailId
    ? replyUpdate.eq('id', matchedEmailId)
    : replyUpdate.eq('type', 'initial_pitch')

  await replyUpdate

  const { error: activityError } = await supabase.from('activity_log').insert({
    event_type: 'reply_received',
    lead_id: leadId,
    description: `Reply received from ${lead.business_name}`,
    metadata: inboundReceiptId ? { inbound_receipt_id: inboundReceiptId } : {},
  })
  if (activityError && activityError.code !== '23505') {
    throw new Error(`Reply activity could not be stored: ${activityError.message}`)
  }

  logger.info('tracker', `Reply received from ${lead.business_name}`, { lead_id: leadId })
}

function inboundHeader(headers: Record<string, string> | null, name: string): string {
  if (!headers) return ''
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]?.trim() ?? ''
}

export interface NormalizedInboundMessage {
  provider: 'resend' | 'hostinger'
  providerMessageId: string
  mailboxId?: string
  folder?: string
  uid?: number | string
  from: string
  to?: string[]
  subject?: string
  messageId?: string
  inReplyTo?: string[]
  references?: string[]
  headers: Record<string, string>
  receivedAt?: string
  receiptId?: string
}

export type InboundReplyOutcome =
  | 'processed'
  | 'automated_ignored'
  | 'unmatched'
  | 'unmatched_ambiguous'

export interface InboundReplyResult {
  outcome: InboundReplyOutcome
  leadId?: string
  emailId?: string
}

const RELEVANT_REPLY_STATUSES = new Set(['contacted', 'dead', 'replied', 'negotiating', 'closed'])

export function parseMessageIds(value: string | string[] | null | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : []
  const ids: string[] = []

  for (const item of values) {
    for (const match of item.matchAll(/<[^<>\s@]+@[^<>\s@]+>/g)) {
      if (!ids.includes(match[0])) ids.push(match[0])
    }
  }

  return ids
}

export function normalizeInboundEmailAddress(value: string): string {
  const angleAddress = value.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1]
  const plainAddress = value.match(/(?:^|[\s,(])([^\s<>,()]+@[^\s<>,()]+)(?:$|[\s,)])/i)?.[1]
  return (angleAddress ?? plainAddress ?? value).trim().replace(/^mailto:/i, '').toLowerCase()
}

// Conservative, deterministic filtering for obvious machine-generated mail.
// This intentionally does not attempt to classify the message body or infer
// ambiguous replies; it only honors standard automation headers and familiar
// delivery/auto-reply sender and subject markers.
export function isAutomatedInboundEmail(params: {
  from: string
  subject?: string
  headers: Record<string, string> | null
}): boolean {
  const autoSubmitted = inboundHeader(params.headers, 'auto-submitted').toLowerCase()
  if (autoSubmitted && autoSubmitted !== 'no') return true

  if (inboundHeader(params.headers, 'x-autoreply') || inboundHeader(params.headers, 'x-autorespond')) return true

  const precedence = inboundHeader(params.headers, 'precedence').toLowerCase()
  if (['bulk', 'junk', 'list'].includes(precedence)) return true

  const from = normalizeInboundEmailAddress(params.from)
  const localPart = from.split('@', 1)[0] ?? ''
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce)(?:[+._-]|$)/.test(localPart)) return true

  const subject = params.subject?.trim().toLowerCase() ?? ''
  return /^(automatic reply|auto(?:matic)?[ -]?reply|out of office|away from (?:the )?office|delivery status notification|undeliverable|delivery failure|mail delivery failed|returned mail|mail delivery subsystem)\b/.test(subject)
}

type ServiceClient = ReturnType<typeof createServiceClient>

async function findUniqueEmailByMessageIds(
  messageIds: string[],
  supabase: ServiceClient,
): Promise<{ id: string; lead_id: string } | null> {
  const matches = new Map<string, { id: string; lead_id: string }>()

  for (const messageId of messageIds) {
    const { data, error } = await supabase
      .from('emails')
      .select('id, lead_id')
      .eq('message_id', messageId)
      .limit(2)
    if (error) throw new Error(`Inbound Message-ID lookup failed: ${error.message}`)

    for (const row of data ?? []) matches.set(row.id, row)
  }

  return matches.size === 1 ? [...matches.values()][0] : null
}

async function findReferenceMatch(
  messageIdsNewestFirst: string[],
  supabase: ServiceClient,
): Promise<{ id: string; lead_id: string } | null> {
  for (const messageId of messageIdsNewestFirst) {
    const { data, error } = await supabase
      .from('emails')
      .select('id, lead_id')
      .eq('message_id', messageId)
      .limit(2)
    if (error) throw new Error(`Inbound References lookup failed: ${error.message}`)

    if (data?.length === 1) return data[0]
  }

  return null
}

async function findUniqueSenderFallback(
  sender: string,
  supabase: ServiceClient,
): Promise<{ leadId: string } | 'ambiguous' | null> {
  const normalized = normalizeInboundEmailAddress(sender)
  if (!normalized.includes('@')) return null

  const { data: possibleLeads, error: leadLookupError } = await supabase
    .from('leads')
    .select('id, status')
    .ilike('email', normalized)
  if (leadLookupError) throw new Error(`Inbound sender lookup failed: ${leadLookupError.message}`)

  const eligibleLeadIds: string[] = []
  for (const lead of possibleLeads ?? []) {
    if (!RELEVANT_REPLY_STATUSES.has(lead.status)) continue

    const { data: priorEmails, error: emailLookupError } = await supabase
      .from('emails')
      .select('id, sent_at')
      .eq('lead_id', lead.id)
      .limit(100)
    if (emailLookupError) throw new Error(`Inbound outreach history lookup failed: ${emailLookupError.message}`)

    if (priorEmails?.some((email) => !!email.sent_at)) eligibleLeadIds.push(lead.id)
  }

  if (eligibleLeadIds.length > 1) return 'ambiguous'
  return eligibleLeadIds.length === 1 ? { leadId: eligibleLeadIds[0] } : null
}

async function logUnmatchedInbound(
  message: NormalizedInboundMessage,
  outcome: 'unmatched' | 'unmatched_ambiguous',
  supabase: ServiceClient,
): Promise<void> {
  const { error } = await supabase.from('activity_log').insert({
    event_type: 'inbound_reply_unmatched',
    lead_id: null,
    description: outcome === 'unmatched_ambiguous'
      ? 'Inbound reply matched multiple leads and was not applied'
      : 'Inbound message could not be matched to an outreach lead',
    metadata: {
      provider: message.provider,
      provider_message_id: message.providerMessageId,
      mailbox_id: message.mailboxId ?? null,
      folder: message.folder ?? null,
      uid: message.uid ?? null,
      status: outcome,
      inbound_receipt_id: message.receiptId ?? null,
    },
  })
  if (error && error.code !== '23505') throw new Error(`Inbound unmatched marker could not be stored: ${error.message}`)
}

export async function processInboundReply(
  message: NormalizedInboundMessage,
  supabaseOverride?: ServiceClient,
): Promise<InboundReplyResult> {
  const supabase = supabaseOverride ?? createServiceClient()
  const headers = message.headers ?? {}

  if (isAutomatedInboundEmail({ from: message.from, subject: message.subject, headers })) {
    logger.info('tracker', 'Automated inbound email ignored', {
      provider: message.provider,
      provider_message_id: message.providerMessageId,
      mailbox_id: message.mailboxId ?? null,
      folder: message.folder ?? null,
      uid: message.uid ?? null,
      outcome: 'automated_ignored',
    })
    return { outcome: 'automated_ignored' }
  }

  const inReplyTo = parseMessageIds([
    ...(message.inReplyTo ?? []),
    inboundHeader(headers, 'in-reply-to'),
  ])
  const referencesOldestFirst = parseMessageIds([
    ...(message.references ?? []),
    inboundHeader(headers, 'references'),
  ])

  let matchedEmail = await findUniqueEmailByMessageIds(inReplyTo, supabase)
  if (!matchedEmail) {
    matchedEmail = await findReferenceMatch([...referencesOldestFirst].reverse(), supabase)
  }

  let leadId = matchedEmail?.lead_id ?? null
  if (!leadId) {
    const senderMatch = await findUniqueSenderFallback(message.from, supabase)
    if (senderMatch === 'ambiguous') {
      await logUnmatchedInbound(message, 'unmatched_ambiguous', supabase)
      logger.warn('tracker', 'Inbound reply matched multiple eligible leads', {
        provider: message.provider,
        provider_message_id: message.providerMessageId,
        outcome: 'unmatched_ambiguous',
      })
      return { outcome: 'unmatched_ambiguous' }
    }
    leadId = senderMatch?.leadId ?? null
  }

  if (!leadId) {
    await logUnmatchedInbound(message, 'unmatched', supabase)
    logger.info('tracker', 'Inbound email received but no matching lead found', {
      provider: message.provider,
      provider_message_id: message.providerMessageId,
      had_in_reply_to: inReplyTo.length > 0,
      had_references: referencesOldestFirst.length > 0,
      outcome: 'unmatched',
    })
    return { outcome: 'unmatched' }
  }

  await handleEmailReply(leadId, supabase, matchedEmail?.id, message.receivedAt, message.receiptId)
  return { outcome: 'processed', leadId, emailId: matchedEmail?.id }
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
  params: { emailId: string; from: string; subject?: string },
  supabaseOverride?: ReturnType<typeof createServiceClient>,
  fetchHeaders: typeof getReceivedEmailHeaders = getReceivedEmailHeaders
): Promise<void> {
  const headers = await fetchHeaders(params.emailId)
  await processInboundReply({
    provider: 'resend',
    providerMessageId: params.emailId,
    from: params.from,
    subject: params.subject,
    messageId: inboundHeader(headers, 'message-id') || undefined,
    inReplyTo: parseMessageIds(inboundHeader(headers, 'in-reply-to')),
    references: parseMessageIds(inboundHeader(headers, 'references')),
    headers: headers ?? {},
  }, supabaseOverride)
}

export async function handleTerminalDeliveryFailure(
  params: {
    taggedLeadId?: string | null
    resendId: string
    eventType: TerminalResendEvent
    recipient?: string | null
    providerReason?: unknown
  },
  supabaseOverride?: ReturnType<typeof createServiceClient>,
): Promise<boolean> {
  const supabase = supabaseOverride ?? createServiceClient()
  const terminalStatus = TERMINAL_RESEND_EVENTS[params.eventType]

  const { data: email, error: lookupErr } = await supabase
    .from('emails')
    .select('id, lead_id, type, status')
    .eq('resend_id', params.resendId)
    .limit(1)
    .maybeSingle()

  if (lookupErr || !email) {
    logger.error('tracker', 'DELIVERY_TERMINAL_FAILURE: provider email could not be matched', {
      lead_id: params.taggedLeadId ?? null,
      resend_id: params.resendId,
      provider_event: params.eventType,
      error: lookupErr?.message ?? 'email row not found',
    })
    return false
  }

  const leadId = email.lead_id as string
  const { data: lead } = await supabase
    .from('leads')
    .select('email, delivery_suppressed_emails')
    .eq('id', leadId)
    .maybeSingle()

  const recipient = normalizeDeliveryEmail(params.recipient) ?? normalizeDeliveryEmail(lead?.email)
  const affectsCurrentAddress = recipient !== null && recipient === normalizeDeliveryEmail(lead?.email)
  const alreadySameTerminal = email.status === terminalStatus
  const persistedStatus = isTerminalDeliveryStatus(email.status) ? email.status : terminalStatus

  // Terminal states are absorbing: repeated terminal events are safe and no
  // later weak event handled by this integration can regress the row.
  let updateErr: { message: string } | null = null
  if (!isTerminalDeliveryStatus(email.status)) {
    const result = await supabase
      .from('emails')
      .update({ status: terminalStatus })
      .eq('id', email.id)
    updateErr = result.error
  }

  if (updateErr) {
    logger.error('tracker', 'Failed to persist terminal email status', {
      lead_id:   leadId,
      email_id:  email.id,
      resend_id: params.resendId,
      provider_event: params.eventType,
      error:     updateErr.message,
    })
    throw new Error(updateErr.message)
  }

  if (recipient) {
    const { error: suppressErr } = await supabase.rpc('suppress_lead_delivery_email', {
      p_lead_id: leadId,
      p_email: recipient,
    })
    if (suppressErr) throw new Error(`Failed to suppress recipient address: ${suppressErr.message}`)
  }

  if (affectsCurrentAddress) {
    const { error: cancelErr } = await supabase
      .from('follow_ups')
      .update({ status: 'cancelled' })
      .eq('lead_id', leadId)
      .eq('status', 'scheduled')
    if (cancelErr) throw new Error(`Failed to cancel pending follow-ups: ${cancelErr.message}`)
  }

  const { error: logErr } = await supabase.from('activity_log').insert({
    event_type: 'delivery_terminal_failure',
    lead_id: leadId,
    description: `Terminal Resend delivery failure (${params.eventType})`,
    metadata: {
      email_id: email.id,
      email_type: email.type,
      resend_id: params.resendId,
      provider_event: params.eventType,
      provider_status: terminalStatus,
      persisted_status: persistedStatus,
      provider_reason: params.providerReason ?? null,
      recipient,
      affects_current_address: affectsCurrentAddress,
      duplicate: alreadySameTerminal,
    },
  })
  if (logErr) throw new Error(`Failed to record terminal provider event: ${logErr.message}`)

  logger.warn('tracker', 'DELIVERY_TERMINAL_FAILURE', {
    lead_id: leadId,
    email_id: email.id,
    email_type: email.type,
    resend_id: params.resendId,
    provider_event: params.eventType,
    provider_status: terminalStatus,
    recipient,
    affects_current_address: affectsCurrentAddress,
    duplicate: alreadySameTerminal,
  })
  return true
}

// Backwards-compatible wrapper retained for existing callers/tests.
export async function handleEmailBounce(
  leadId: string,
  resendId: string,
  supabaseOverride?: ReturnType<typeof createServiceClient>,
): Promise<void> {
  await handleTerminalDeliveryFailure(
    { taggedLeadId: leadId, resendId, eventType: 'email.bounced' },
    supabaseOverride,
  )
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
