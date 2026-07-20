import { createServiceClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/resend'
import { logger } from '@/lib/logger'
import { getAnalyticsDayRange } from '@/lib/analytics'
import { handleEmailSyncFailure } from '@/lib/email-status'
import { acquireLock, releaseLock } from '@/lib/distributed-lock'

// Held for the entire quota-check-then-send sequence below so two overlapping
// invocations (a stuck old run, a manual script racing the scheduled
// pipeline, a platform-level retry) can never both count the same "sent
// today" snapshot and then both send against it — see migration 028.
// Trigger.dev's own queue concurrencyLimit:1 (trigger/daily-pipeline.ts)
// already prevents overlapping *scheduled* runs; this lock is the DB-level
// backstop that holds regardless of how runSenderAgent() is invoked.
const SENDER_LOCK_KEY = 'sender_agent'

export async function runSenderAgent(): Promise<{ sent: number; failed: number }> {
  const supabase = createServiceClient()

  try {
  const { data: systemSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'system_active')
    .single()

  logger.info('sender', `system_active = "${systemSetting?.value}"`)

  if (systemSetting?.value !== 'true') {
    logger.info('sender', '[PIPELINE_STAGE] Sender exiting', { reason: 'system_paused', system_active: systemSetting?.value ?? null })
    return { sent: 0, failed: 0 }
  }

  const lockToken = await acquireLock(supabase, SENDER_LOCK_KEY)
  if (!lockToken) {
    logger.warn('sender', '[PIPELINE_STAGE] Sender exiting', { reason: 'concurrent_run_in_progress' })
    return { sent: 0, failed: 0 }
  }

  try {

  const [globalLimitRow, limitRow] = await Promise.all([
    supabase.from('settings').select('value').eq('key', 'daily_lead_limit').single(),
    supabase.from('settings').select('value').eq('key', 'daily_initial_outreach_limit').single(),
  ])

  const globalDailyLimit = parseInt(globalLimitRow.data?.value ?? '100', 10)
  const dailyLimit       = parseInt(limitRow.data?.value ?? '50', 10)

  const today = getAnalyticsDayRange()

  // Global cap: count all outbound email types sent today.
  const { count: totalSentToday } = await supabase
    .from('emails')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'sent')
    .in('type', ['initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3'])
    .gte('sent_at', today.start)
    .lt('sent_at', today.end)

  // Sub-limit: count only initial pitches sent today.
  const { count: sentToday } = await supabase
    .from('emails')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'sent')
    .eq('type', 'initial_pitch')
    .gte('sent_at', today.start)
    .lt('sent_at', today.end)

  const globalRemaining  = Math.max(0, globalDailyLimit - (totalSentToday ?? 0))
  const initialRemaining = Math.max(0, dailyLimit - (sentToday ?? 0))
  const remainingToday   = Math.min(globalRemaining, initialRemaining)

  logger.info('sender', `GLOBAL_DAILY_SEND_LIMIT = ${globalDailyLimit}`)
  logger.info('sender', `INITIAL_OUTREACH_LIMIT = ${dailyLimit}`)
  logger.info('sender', `TOTAL_SENT_TODAY = ${totalSentToday ?? 0} / ${globalDailyLimit}`, {
    total_sent_today:        totalSentToday ?? 0,
    global_daily_send_limit: globalDailyLimit,
    global_remaining:        globalRemaining,
    today_range:             today,
  })
  logger.info('sender', `INITIAL_OUTREACH_TARGET = ${remainingToday}`, {
    daily_initial_outreach_limit: dailyLimit,
    initial_sent_today:           sentToday ?? 0,
    initial_remaining:            initialRemaining,
    global_remaining:             globalRemaining,
    capped_to:                    remainingToday,
  })

  // Early exit — must be here, before any diagnostic DB queries, so the pipeline
  // immediately proceeds to the follow-up stage when initial outreach is at capacity.
  if (remainingToday === 0) {
    const exitReason = globalRemaining === 0 ? 'global_daily_send_limit_reached' : 'daily_initial_outreach_limit_reached'
    logger.info('sender', '[PIPELINE_STAGE] Sender exiting', {
      reason:                       exitReason,
      global_daily_send_limit:      globalDailyLimit,
      total_sent_today:             totalSentToday ?? 0,
      daily_initial_outreach_limit: dailyLimit,
      initial_sent_today:           sentToday ?? 0,
    })
    return { sent: 0, failed: 0 }
  }

  const emailStatusesQueried = ['pending_send']
  const emailTypesQueried = ['initial_pitch']
  const leadStatusesQueried = ['email_ready']

  // Diagnostic: count total pending_send emails before applying limit
  const { count: pendingCount } = await supabase
    .from('emails')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending_send')
  logger.info('sender', `emails with status=pending_send: ${pendingCount ?? 0}`)

  // Diagnostic: count leads with email_ready status
  const { count: emailReadyCount } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'email_ready')
  logger.info('sender', `leads with status=email_ready: ${emailReadyCount ?? 0}`)

  // Diagnostic: count email_ready leads that actually have an email address
  const { count: emailReadyWithEmail } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'email_ready')
    .not('email', 'is', null)
  logger.info('sender', `email_ready leads with a real email: ${emailReadyWithEmail ?? 0}`)

  const { count: eligiblePendingCount, error: eligibleCountErr } = await supabase
    .from('emails')
    .select('id, leads!inner(id)', { count: 'exact', head: true })
    .eq('status', 'pending_send')
    .eq('type', 'initial_pitch')
    .eq('leads.status', 'email_ready')
    .neq('leads.source', 'manual')

  if (eligibleCountErr) {
    logger.error('sender', '[SENDER_QUERY] Eligible count failed', { error: eligibleCountErr.message })
    throw eligibleCountErr
  }

  logger.info('sender', '[SENDER_QUERY]', {
    statuses_queried: emailStatusesQueried,
    email_types_queried: emailTypesQueried,
    lead_statuses_queried: leadStatusesQueried,
    pending_rows_found: eligiblePendingCount ?? 0,
    pending_send_rows_all_types: pendingCount ?? 0,
    email_ready_leads: emailReadyCount ?? 0,
    email_ready_with_email: emailReadyWithEmail ?? 0,
  })

const { data: pendingEmailsRaw, error: pendingEmailsErr } = await supabase
  .from('emails')
  .select('*, leads!inner(id, email, business_name, status, source)')
  .eq('status', 'pending_send')
  .eq('type', 'initial_pitch')
  .order('created_at', { ascending: true })
.limit(100)

  const pendingEmails = (pendingEmailsRaw || []).filter(
  (email) => email.leads?.status === 'email_ready' && email.leads?.source !== 'manual'
)
console.log("RAW PENDING", pendingEmailsRaw)
console.log("FILTERED PENDING", pendingEmails)
  if (pendingEmailsErr) {
    logger.error('sender', '[SENDER_QUERY] Selection failed', { error: pendingEmailsErr.message })
    throw pendingEmailsErr
  }

  logger.info('sender', `fetched ${pendingEmails?.length ?? 0} pending emails to process`)
  logger.info('sender', '[SENDER_SELECTION]', {
    selected_email_ids: (pendingEmails ?? []).map((email) => email.id),
    selected_lead_ids: (pendingEmails ?? []).map((email) => email.lead_id),
  })

  if (!pendingEmails?.length) {
    logger.info('sender', '[PIPELINE_STAGE] Sender exiting', {
      reason: 'no_pending_initial_pitch_emails',
      pending_send_emails: pendingCount ?? 0,
      eligible_pending_send_emails: eligiblePendingCount ?? 0,
      email_ready_leads: emailReadyCount ?? 0,
      email_ready_with_email: emailReadyWithEmail ?? 0,
    })
    return { sent: 0, failed: 0 }
  }

  // Apply hard cap: never send more initial outreach than remaining quota allows.
  const toSend = pendingEmails.slice(0, remainingToday)

  let sent = 0
  let failed = 0
  const total = toSend.length

  for (let i = 0; i < toSend.length; i++) {
    const emailRecord = toSend[i]
    const lead = emailRecord.leads as { id: string; email: string | null; business_name: string; status: string; source: string | null } | null

    if (!lead?.email) {
      logger.info('sender', `#${i + 1}/${total} SKIP — no email address for lead`, { lead_id: emailRecord.lead_id })
      await supabase.from('emails').update({ status: 'failed' }).eq('id', emailRecord.id)
      failed++
      continue
    }

    // Idempotency: skip if this lead already has a delivered or sync-failed email.
    // 'email_sync_failed' is included because it means Resend accepted the email
    // even though the DB update failed — re-sending would cause a duplicate delivery.
    const { data: alreadySent } = await supabase
      .from('emails')
      .select('id')
      .eq('lead_id', emailRecord.lead_id)
      .in('status', ['sent', 'email_sync_failed'])
      .neq('id', emailRecord.id)
      .limit(1)

    if (alreadySent?.length) {
      logger.warn('sender', `Idempotency skip: already sent or sync-failed for lead`, { lead_id: emailRecord.lead_id })
      await supabase.from('emails').update({ status: 'failed' }).eq('id', emailRecord.id)
      continue
    }

    logger.info('sender', `#${i + 1}/${total} Sending to ${lead.email} (${lead.business_name})`, { subject: emailRecord.subject })

    try {
const result = await sendEmail({
    to: lead.email,
    subject: emailRecord.subject,
    html: emailRecord.body_html,
    text: emailRecord.body_text,
    leadId: emailRecord.lead_id,
  })


      if (result) {
        logger.info('sender', `#${i + 1}/${total} SUCCESS`, { resend_id: result.id, to: lead.email })

        const sentAt = new Date().toISOString()
        const { error: emailUpdateErr } = await supabase.from('emails').update({
          status:     'sent',
          resend_id:  result.id,
          message_id: result.messageId,
          sent_at:    sentAt,
        }).eq('id', emailRecord.id)

        if (emailUpdateErr) {
          await handleEmailSyncFailure(supabase, {
            agent:    'sender',
            emailId:  emailRecord.id,
            leadId:   emailRecord.lead_id,
            resendId: result.id,
            sentAt,
            context: {
              position:         `#${i + 1}/${total}`,
              original_db_error: emailUpdateErr.message,
              to:               lead.email,
            },
          })
          failed++
          continue
        }

        const { error: leadUpdateErr } = await supabase.from('leads').update({ status: 'contacted', updated_at: sentAt }).eq('id', emailRecord.lead_id)

        if (leadUpdateErr) {
          logger.error('sender', `#${i + 1}/${total} DB error updating lead status after send`, {
            error: leadUpdateErr.message,
            lead_id: emailRecord.lead_id,
          })
          failed++
          continue
        }

        await supabase.from('activity_log').insert({
          event_type: 'email_sent',
          lead_id: emailRecord.lead_id,
          description: `Email sent to ${lead.business_name} (${lead.email})`,
          metadata: { resend_id: result.id, subject: emailRecord.subject },
        })

        sent++
      } else {
        logger.error('sender', `#${i + 1}/${total} FAILED — sendEmail returned null`, { to: lead.email })

        await supabase.from('emails').update({ status: 'failed' }).eq('id', emailRecord.id)

        await supabase.from('dead_letter_queue').insert({
          operation: 'send_email',
          payload: { lead_id: emailRecord.lead_id, email: lead.email, subject: emailRecord.subject, email_id: emailRecord.id },
          error: 'Resend API returned null/error',
        })

        await supabase.from('activity_log').insert({
          event_type: 'email_failed',
          lead_id: emailRecord.lead_id,
          description: `Failed to send email to ${lead.business_name} (${lead.email})`,
          metadata: { to: lead.email, subject: emailRecord.subject },
        })

        failed++
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error('sender', `#${i + 1}/${total} EXCEPTION for ${lead.email}: ${msg}`)

      await supabase.from('emails').update({ status: 'failed' }).eq('id', emailRecord.id)

      await supabase.from('dead_letter_queue').insert({
        operation: 'send_email',
        payload: { lead_id: emailRecord.lead_id, email: lead.email, subject: emailRecord.subject, email_id: emailRecord.id },
        error: msg,
      })

      await supabase.from('activity_log').insert({
        event_type: 'agent_error',
        lead_id: emailRecord.lead_id,
        description: `Exception sending to ${lead.business_name} (${lead.email}): ${msg}`,
        metadata: { error: msg, to: lead.email },
      })
      failed++
    }
  }

  await supabase.from('activity_log').insert({
    event_type: 'sender_complete',
    description: `Sender agent completed - ${sent} sent, ${failed} failed`,
    metadata: { sent, failed, global_daily_send_limit: globalDailyLimit, daily_initial_outreach_limit: dailyLimit, initial_pitch_sent_before_run: sentToday ?? 0 },
  })

  // Haiku writing (~$0.001/email) + Resend API (free tier / ~$0.0001/email)
  const estimatedCost = (sent * 0.0011).toFixed(4)
  logger.info('sender', '[OUTREACH_SENT]', { new_outreach_sent: sent })
  logger.info('sender', '[PIPELINE_STAGE] Sender complete', { sent, failed })
  logger.info('sender', `Total pipeline cost estimate: $${estimatedCost} (Haiku writing + Resend; see finder log for Outscraper cost)`)
  return { sent, failed }

  } finally {
    await releaseLock(supabase, SENDER_LOCK_KEY, lockToken)
  }

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('sender', 'Fatal error', { error: message, stack: error instanceof Error ? error.stack : null })
    await supabase.from('activity_log').insert({
      event_type: 'agent_error',
      description: `Agent failed: ${message}`,
      metadata: {
        agent: 'sender',
        error: message,
        stack: error instanceof Error ? error.stack : null,
        timestamp: new Date().toISOString(),
      },
    })
    throw error
  }
}
