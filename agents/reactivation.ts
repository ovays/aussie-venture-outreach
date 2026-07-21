import { createServiceClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/resend'
import { emailBodyToHtml } from '@/lib/utils'
import { logger } from '@/lib/logger'
import { writeReactivationEmail } from '@/lib/claude'
import { insertEmailSyncFailedRecovery } from '@/lib/email-status'
import { getAnalyticsDayRange } from '@/lib/analytics'

interface LeadEmail {
  id: string
  type: string
  subject: string
  sent_at: string | null
}

interface ContactedLead {
  id: string
  business_name: string
  email: string | null
  reactivation_sent_at: string | null
  category_name: string | null
  suburb: string | null
  city: string | null
  content_type: string | null
  emails: LeadEmail[]
}

export async function runReactivationAgent(): Promise<void> {
  const supabase = createServiceClient()

  try {
    const { data: systemSetting } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'system_active')
      .single()

    if (systemSetting?.value !== 'true') {
      logger.info('reactivation', 'System paused — skipped')
      return
    }

    const { data: settingsRows } = await supabase
      .from('settings')
      .select('key, value')
      .in('key', ['reactivation_enabled', 'reactivation_delay_days', 'dead_after_reactivation_days', 'daily_reactivation_limit'])

    const settingsMap: Record<string, string> = {}
    for (const row of settingsRows ?? []) {
      settingsMap[row.key] = row.value
    }

    const reactivationEnabled = settingsMap['reactivation_enabled'] === 'true'

    if (!reactivationEnabled) {
      logger.info('reactivation', 'Reactivation disabled — skipped')
      return
    }

    const reactivationDelayDays = parseInt(settingsMap['reactivation_delay_days'] ?? '60', 10)
    const deadAfterReactivationDays = parseInt(settingsMap['dead_after_reactivation_days'] ?? '14', 10)

    // Daily send cap — independent of daily_initial_outreach_limit (which only
    // governs the finder/sender's cold-outreach queue). Counts reactivation emails
    // already sent today (Sydney calendar day) so repeated pipeline runs on the
    // same day never exceed the configured limit in aggregate.
    //
    // This read-then-send sequence is check-then-act, not atomic — it only stays
    // race-free because runReactivationAgent() currently has a single entry point,
    // trigger/daily-pipeline.ts, whose queue sets concurrencyLimit: 1 (no two runs
    // of the pipeline ever execute this concurrently). If another entry point is
    // ever added that can invoke this function concurrently with the pipeline (or
    // with itself), this budget calculation must be protected with an atomic
    // mechanism (e.g. a DB advisory lock or an atomic counter update) or the daily
    // limit can be exceeded.
    const dailyReactivationLimit = parseInt(settingsMap['daily_reactivation_limit'] ?? '10', 10)
    const today = getAnalyticsDayRange()
    const { count: reactivationSentToday } = await supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'sent')
      .eq('type', 'reactivation')
      .gte('sent_at', today.start)
      .lt('sent_at', today.end)

    const remainingReactivationBudget = Math.max(0, dailyReactivationLimit - (reactivationSentToday ?? 0))

    logger.info('reactivation', `DAILY_REACTIVATION_LIMIT = ${dailyReactivationLimit}`, {
      daily_reactivation_limit: dailyReactivationLimit,
      reactivation_sent_today: reactivationSentToday ?? 0,
      remaining_reactivation_budget: remainingReactivationBudget,
    })

    const { data: contactedLeads } = await supabase
      .from('leads')
      .select('id, business_name, email, reactivation_sent_at, category_name, suburb, city, content_type, emails(id, type, subject, sent_at)')
      .eq('status', 'contacted')

    if (!contactedLeads?.length) {
      logger.info('reactivation', 'No contacted leads to process')
      return
    }

    let eligible = 0
    let reactivationSent = 0
    let markedDead = 0

    // Phase 1: walk every contacted lead — handle the dead-after-reactivation path
    // inline (unaffected by the daily send cap, since it never sends anything), and
    // collect leads eligible for a NEW reactivation send into a queue instead of
    // sending immediately. Eligibility logic itself is unchanged from before.
    const eligibleForSend: Array<{ lead: ContactedLead; daysSinceInitial: number }> = []

    for (const lead of contactedLeads as ContactedLead[]) {
      if (!lead.email) continue

      try {
      const emailsList = lead.emails ?? []

      // Dead-after-reactivation path: reactivation was already sent, check if lead should now be marked dead.
      // Timing is relative to reactivation_sent_at, NOT the initial outreach date.
      if (lead.reactivation_sent_at) {
        const daysSinceReactivation = Math.floor(
          (Date.now() - new Date(lead.reactivation_sent_at).getTime()) / 86_400_000
        )
        if (daysSinceReactivation >= deadAfterReactivationDays) {
          console.log(`[REACTIVATION_DEAD] lead=${lead.business_name} days_since_reactivation=${daysSinceReactivation}`)
          await supabase.from('leads').update({ status: 'dead' }).eq('id', lead.id)
          await supabase.from('activity_log').insert({
            event_type: 'lead_marked_dead',
            lead_id: lead.id,
            description: `Lead marked dead after reactivation: ${lead.business_name} (${daysSinceReactivation}d since reactivation, no reply)`,
            metadata: {
              days_since_reactivation: daysSinceReactivation,
              dead_after_reactivation_days: deadAfterReactivationDays,
            },
          })
          markedDead++
        }
        continue
      }

      // Reactivation eligibility.
      // Must have completed follow_up_3 to ensure lead went through the full outreach flow.
      // Timing is relative to initial outreach date (NOT dead date or followup date).
      const initialEmail = emailsList.find((e) => e.type === 'initial_pitch' && e.sent_at)
      if (!initialEmail?.sent_at) continue

      const hasFollowUp3 = emailsList.some((e) => e.type === 'follow_up_3' && e.sent_at)
      if (!hasFollowUp3) continue

      const daysSinceInitial = Math.floor(
        (Date.now() - new Date(initialEmail.sent_at).getTime()) / 86_400_000
      )

      if (daysSinceInitial < reactivationDelayDays) continue

      eligible++
      console.log(`[REACTIVATION_ELIGIBLE] lead=${lead.business_name} days_since_initial=${daysSinceInitial}`)
      eligibleForSend.push({ lead, daysSinceInitial })
      } catch (error) {
        // One lead's transient DB/network exception must not abort the rest
        // of this batch (see agents/sender.ts's per-item try/catch for the
        // same reasoning) — this is the last pipeline stage each run.
        const msg = error instanceof Error ? error.message : String(error)
        logger.error('reactivation', `Exception processing lead: ${lead.business_name}: ${msg}`, { lead_id: lead.id })
      }
    }

    // Phase 2: apply the daily cap — send only the first N eligible leads this run.
    // Anything past the cap is left untouched (still status='contacted',
    // reactivation_sent_at NULL) and re-evaluated as eligible on the next run.
    const toSend = eligibleForSend.slice(0, remainingReactivationBudget)
    const deferredForLimit = eligibleForSend.length - toSend.length

    if (deferredForLimit > 0) {
      logger.info('reactivation', `DAILY_REACTIVATION_LIMIT_REACHED — deferring ${deferredForLimit} eligible lead(s) to next run`, {
        eligible_this_run: eligibleForSend.length,
        remaining_reactivation_budget: remainingReactivationBudget,
        deferred: deferredForLimit,
      })
    }

    for (const { lead, daysSinceInitial } of toSend) {
      if (!lead.email) continue // already guaranteed by the phase-1 filter; narrows the type for sendEmail() below

      try {
      const emailResult = await writeReactivationEmail({
        business_name: lead.business_name,
        category: lead.category_name ?? 'local business',
        suburb: lead.suburb ?? '',
        city: lead.city ?? 'Sydney',
        content_type: lead.content_type ?? 'remote',
      })

      console.log(`[REACTIVATION_EMAIL_GENERATED] lead=${lead.business_name} category=${lead.category_name ?? 'unknown'}`)
      console.log(`[REACTIVATION_SUBJECT] subject="${emailResult.subject}"`)
      console.log(`[REACTIVATION_TEMPLATE_USED] template=reactivation_pitch`)

      const subject = emailResult.subject
      const body = emailResult.body
      const html = emailBodyToHtml(body)

      const result = await sendEmail({
        to: lead.email,
        subject,
        html,
        text: body,
        leadId: lead.id,
      })

      const sentAt = new Date().toISOString()

      const { error: insertErr } = await supabase.from('emails').insert({
        lead_id:    lead.id,
        type:       'reactivation',
        subject,
        body_html:  html,
        body_text:  body,
        resend_id:  result?.id ?? null,
        message_id: result?.messageId ?? null,
        status:     result ? 'sent' : 'failed',
        sent_at:    result ? sentAt : null,
      })

      if (insertErr) {
        if (result) {
          await insertEmailSyncFailedRecovery(supabase, {
            agent:    'reactivation',
            leadId:   lead.id,
            type:     'reactivation',
            subject,
            bodyHtml: html,
            bodyText: body,
            resendId: result.id,
            messageId: result.messageId,
            sentAt,
          })
        } else {
          console.error(`[REACTIVATION_DB_ERROR] lead=${lead.business_name} error=${insertErr.message} resend_sent=false`)
        }
        continue
      }

      if (result) {
        const { error: leadUpdateErr } = await supabase.from('leads').update({ reactivation_sent_at: sentAt }).eq('id', lead.id)
        if (leadUpdateErr) {
          console.error(`[REACTIVATION_LEAD_UPDATE_ERROR] lead=${lead.business_name} error=${leadUpdateErr.message}`)
          continue
        }
        console.log(`[REACTIVATION_SENT] lead=${lead.business_name} email=${lead.email}`)
        reactivationSent++
      }

      await supabase.from('activity_log').insert({
        event_type: 'reactivation_sent',
        lead_id: lead.id,
        description: `Reactivation email ${result ? 'sent' : 'failed'}: ${lead.business_name} (${daysSinceInitial}d since initial outreach)`,
        metadata: {
          days_since_initial: daysSinceInitial,
          reactivation_delay_days: reactivationDelayDays,
          status: result ? 'sent' : 'failed',
        },
      })
      } catch (error) {
        // One lead's transient DB/network exception must not abort the rest
        // of this batch (see agents/sender.ts's per-item try/catch for the
        // same reasoning) — this is the last pipeline stage each run.
        const msg = error instanceof Error ? error.message : String(error)
        logger.error('reactivation', `Exception processing lead: ${lead.business_name}: ${msg}`, { lead_id: lead.id })
      }
    }

    logger.info('reactivation', 'Reactivation agent complete', { eligible, reactivationSent, markedDead, deferredForLimit })

    await supabase.from('activity_log').insert({
      event_type: 'reactivation_complete',
      description: `Reactivation agent done. Eligible: ${eligible}, Sent: ${reactivationSent}, Dead: ${markedDead}, Deferred (daily limit): ${deferredForLimit}`,
      metadata: {
        eligible,
        reactivation_sent: reactivationSent,
        marked_dead: markedDead,
        deferred_for_daily_limit: deferredForLimit,
        daily_reactivation_limit: dailyReactivationLimit,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('reactivation', 'Fatal error', { error: message, stack: error instanceof Error ? error.stack : null })
    await supabase.from('activity_log').insert({
      event_type: 'agent_error',
      description: `Agent failed: ${message}`,
      metadata: {
        agent: 'reactivation',
        error: message,
        stack: error instanceof Error ? error.stack : null,
        timestamp: new Date().toISOString(),
      },
    })
    throw error
  }
}
