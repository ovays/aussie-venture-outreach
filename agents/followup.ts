import { createServiceClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/resend'
import { textToHtml } from '@/lib/utils'
import { getAnalyticsDayRange } from '@/lib/analytics'
import { computeFollowUpEligibility, isFuEmailSent, type FollowUpType } from '@/lib/followup-eligibility'
import { logger } from '@/lib/logger'

interface LeadEmail {
  id: string
  type: string
  subject: string
  sent_at: string | null
  status: string
}

interface ContactedLead {
  id: string
  business_name: string
  email: string | null
  emails: LeadEmail[]
}

interface FollowUpCandidate {
  lead: ContactedLead
  initialEmail: LeadEmail
  daysSince: number
}

const FOLLOW_UP_LIMIT_KEYS: Record<FollowUpType, string> = {
  follow_up_1: 'daily_followup1_limit',
  follow_up_2: 'daily_followup2_limit',
  follow_up_3: 'daily_followup3_limit',
}

const FOLLOW_UP_DEFAULT_LIMITS: Record<FollowUpType, number> = {
  follow_up_1: 20,
  follow_up_2: 10,
  follow_up_3: 5,
}

async function sentTodayCount(
  supabase: ReturnType<typeof createServiceClient>,
  type: FollowUpType,
  range: ReturnType<typeof getAnalyticsDayRange>
) {
  const { count } = await supabase
    .from('emails')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'sent')
    .eq('type', type)
    .gte('sent_at', range.start)
    .lt('sent_at', range.end)

  return count ?? 0
}

function buildFollowUpEmail(type: FollowUpType, leadName: string, initialSubject: string) {
  if (type === 'follow_up_1') {
    const body = `Hey ${leadName}!

Still keen to feature your business on Aussie Venture — our audience genuinely loves discovering great local spots, and I think you'd be a wonderful fit.

Happy to keep things simple on your end. Let me know if you're open to it!

Cheers,
Owais
Aussie Venture
hello@aussieventure.com`

    return {
      subject: `Re: ${initialSubject}`,
      body,
      html: textToHtml(body),
    }
  }

  if (type === 'follow_up_2') {
    const body = `Hey ${leadName},

Timing can always be tricky — no worries if things have been busy on your end!

A feature on Aussie Venture is a simple way to connect your business with a genuinely engaged local audience, and we keep it as easy as possible from your side.

If it sounds like something worth exploring, I'd love to hear your thoughts.

Cheers,
Owais
Aussie Venture
hello@aussieventure.com`

    return {
      subject: `Re: ${initialSubject}`,
      body,
      html: textToHtml(body),
    }
  }

  // follow_up_3
  const body = `Hey ${leadName},

No worries at all if the timing hasn't been right — these things don't always line up!

If a feature on Aussie Venture ever sounds like a good fit down the track, we'd genuinely love to hear from you at hello@aussieventure.com.

Wishing you and the team all the best — hope the business keeps going from strength to strength!

Cheers,
Owais
Aussie Venture`

  return {
    subject: `Re: ${initialSubject}`,
    body,
    html: textToHtml(body),
  }
}

async function sendFollowUp(
  supabase: ReturnType<typeof createServiceClient>,
  candidate: FollowUpCandidate,
  type: FollowUpType
) {
  const followUpNumber = type === 'follow_up_1' ? 1 : type === 'follow_up_2' ? 2 : 3
  const { subject, body, html } = buildFollowUpEmail(type, candidate.lead.business_name, candidate.initialEmail.subject)

  const result = await sendEmail({
    to: candidate.lead.email!,
    subject,
    html,
    text: body,
    leadId: candidate.lead.id,
  })

  const { data: emailRow } = await supabase
    .from('emails')
    .insert({
      lead_id: candidate.lead.id,
      type,
      subject,
      body_html: html,
      body_text: body,
      resend_id: result?.id ?? null,
      status: result ? 'sent' : 'failed',
      sent_at: result ? new Date().toISOString() : null,
    })
    .select()
    .single()

  if (emailRow) {
    await supabase.from('follow_ups').insert({
      lead_id: candidate.lead.id,
      follow_up_number: followUpNumber,
      scheduled_at: new Date().toISOString(),
      sent_at: result ? new Date().toISOString() : null,
      email_id: emailRow.id,
      status: result ? 'sent' : 'cancelled',
    })
  }

  await supabase.from('activity_log').insert({
    event_type: `${type}_sent`,
    lead_id: candidate.lead.id,
    description: `Follow-up ${followUpNumber} sent to ${candidate.lead.business_name}`,
    metadata: { days_since: candidate.daysSince },
  })

  logger.info('followup', `Follow-up ${followUpNumber} sent: ${candidate.lead.business_name}`, {
    daysSince: candidate.daysSince,
  })

  return !!result
}

export async function runFollowUpAgent(): Promise<void> {
  const supabase = createServiceClient()

  try {
    const { data: systemSetting } = await supabase.from('settings').select('value').eq('key', 'system_active').single()

    if (systemSetting?.value !== 'true') {
      logger.info('followup', 'System paused - skipped')
      return
    }

    const { data: settingsRows } = await supabase
      .from('settings')
      .select('key, value')
      .in('key', [
        'follow_up_1_days',
        'follow_up_2_days',
        'follow_up_3_days',
        'dead_lead_days',
        'daily_lead_limit',
        'daily_followup1_limit',
        'daily_followup2_limit',
        'daily_followup3_limit',
        'reactivation_enabled',
      ])

    // reactivation_enabled is a boolean string, handled separately before numeric parse
    const reactivationEnabled = (settingsRows ?? []).find((r) => r.key === 'reactivation_enabled')?.value === 'true'

    const settings: Record<string, number> = {}
    for (const row of settingsRows ?? []) {
      if (row.key === 'reactivation_enabled') continue
      settings[row.key] = parseInt(row.value, 10)
    }

    const followUp1Days = settings['follow_up_1_days'] ?? 7
    const followUp2Days = settings['follow_up_2_days'] ?? 14
    const followUp3Days = settings['follow_up_3_days'] ?? 21

    const configuredGlobalLimit = settings['daily_lead_limit'] ?? 100

    const today = getAnalyticsDayRange()

    // Global cap: total outbound emails sent today across all types.
    const { count: alreadySentToday } = await supabase
      .from('emails')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'sent')
      .in('type', ['initial_pitch', 'follow_up_1', 'follow_up_2', 'follow_up_3'])
      .gte('sent_at', today.start)
      .lt('sent_at', today.end)

    const remainingGlobalToday = Math.max(0, configuredGlobalLimit - (alreadySentToday ?? 0))

    const limits = {
      follow_up_1: settings[FOLLOW_UP_LIMIT_KEYS.follow_up_1] ?? FOLLOW_UP_DEFAULT_LIMITS.follow_up_1,
      follow_up_2: settings[FOLLOW_UP_LIMIT_KEYS.follow_up_2] ?? FOLLOW_UP_DEFAULT_LIMITS.follow_up_2,
      follow_up_3: settings[FOLLOW_UP_LIMIT_KEYS.follow_up_3] ?? FOLLOW_UP_DEFAULT_LIMITS.follow_up_3,
    } satisfies Record<FollowUpType, number>

    const sentBeforeRun = {
      follow_up_1: await sentTodayCount(supabase, 'follow_up_1', today),
      follow_up_2: await sentTodayCount(supabase, 'follow_up_2', today),
      follow_up_3: await sentTodayCount(supabase, 'follow_up_3', today),
    } satisfies Record<FollowUpType, number>

    const fu1SentToday = sentBeforeRun.follow_up_1
    const fu2SentToday = sentBeforeRun.follow_up_2
    const fu3SentToday = sentBeforeRun.follow_up_3

    const remaining = {
      follow_up_1: Math.max(0, limits.follow_up_1 - fu1SentToday),
      follow_up_2: Math.max(0, limits.follow_up_2 - fu2SentToday),
      follow_up_3: Math.max(0, limits.follow_up_3 - fu3SentToday),
    } satisfies Record<FollowUpType, number>

    logger.info('followup', '[FU_QUOTA_DEBUG]', {
      fu1_limit:              limits.follow_up_1,
      fu1_sent_today:         fu1SentToday,
      fu1_remaining:          remaining.follow_up_1,
      fu2_limit:              limits.follow_up_2,
      fu2_sent_today:         fu2SentToday,
      fu2_remaining:          remaining.follow_up_2,
      fu3_limit:              limits.follow_up_3,
      fu3_sent_today:         fu3SentToday,
      fu3_remaining:          remaining.follow_up_3,
      configured_global_limit: configuredGlobalLimit,
      already_sent_today:     alreadySentToday ?? 0,
      remaining_global_today: remainingGlobalToday,
    })

    logger.info('followup', `CONFIGURED_GLOBAL_LIMIT = ${configuredGlobalLimit}`)
    logger.info('followup', `ALREADY_SENT_TODAY = ${alreadySentToday ?? 0} / ${configuredGlobalLimit}`, {
      already_sent_today:      alreadySentToday ?? 0,
      configured_global_limit: configuredGlobalLimit,
      remaining_global_today:  remainingGlobalToday,
    })
    logger.info('followup', `FU1_LIMIT = ${limits.follow_up_1}`)
    logger.info('followup', `FU2_LIMIT = ${limits.follow_up_2}`)
    logger.info('followup', `FU3_LIMIT = ${limits.follow_up_3}`)

    logger.info('followup', '[FU_ELIGIBILITY] querying contacted leads')
    const { data: contactedLeads, error: contactedLeadsErr } = await supabase
      .from('leads')
      .select('*, emails(id, type, subject, sent_at, status)')
      .eq('status', 'contacted')

    if (contactedLeadsErr) {
      logger.error('followup', '[FU_ELIGIBILITY] contacted leads query failed', { error: contactedLeadsErr.message })
      throw contactedLeadsErr
    }

    logger.info('followup', `[FU_ELIGIBILITY] contacted leads fetched: ${contactedLeads?.length ?? 0}`)

    if (!contactedLeads?.length) {
      logger.info('followup', 'No contacted leads to follow up')
      logger.info('followup', '[FOLLOWUP_QUEUE]', { pending_follow_up_1: 0, pending_follow_up_2: 0, pending_follow_up_3: 0 })
      return
    }

    const queues: Record<FollowUpType, FollowUpCandidate[]> = {
      follow_up_1: [],
      follow_up_2: [],
      follow_up_3: [],
    }

    let markedDead = 0
    let skipNoEmail         = 0
    let skipNoInitialEmail  = 0
    let skipNotYetDue       = 0
    let skipAllSent         = 0

    const now = new Date()

    for (const lead of contactedLeads as ContactedLead[]) {
      if (!lead.email) {
        skipNoEmail++
        continue
      }

      const emailsList = lead.emails ?? []
      const initialPitchRows = emailsList.filter((email) => email.type === 'initial_pitch')
      const initialEmail = initialPitchRows.find((email) => isFuEmailSent(email))

      logger.info('followup', '[FU_INITIAL_DEBUG]', {
        lead_id:           lead.id,
        initial_pitch_rows: initialPitchRows.map((e) => ({ id: e.id, status: e.status, sent_at: e.sent_at ?? null })),
        chosen_sent_at:    initialEmail?.sent_at ?? null,
      })

      if (!initialEmail?.sent_at) {
        skipNoInitialEmail++
        logger.info('followup', '[FU_SKIP] no sent initial_pitch email', {
          lead_id:   lead.id,
          lead_name: lead.business_name,
          emails:    emailsList.map((e) => ({ type: e.type, status: e.status, sent_at: e.sent_at ?? null })),
        })
        continue
      }

      const hasFu1Sent = emailsList.some((email) => email.type === 'follow_up_1' && isFuEmailSent(email))
      const hasFu2Sent = emailsList.some((email) => email.type === 'follow_up_2' && isFuEmailSent(email))
      const hasFu3Sent = emailsList.some((email) => email.type === 'follow_up_3' && isFuEmailSent(email))

      const eligibility = computeFollowUpEligibility(
        initialEmail.sent_at,
        hasFu1Sent,
        hasFu2Sent,
        hasFu3Sent,
        { fu1Days: followUp1Days, fu2Days: followUp2Days, fu3Days: followUp3Days },
        now
      )

      logger.info('followup', '[FU_DUE_DEBUG]', {
        lead_id:        lead.id,
        next_fu_type:   eligibility.nextFuType,
        initial_sent_at: initialEmail.sent_at,
        days_since:     eligibility.daysSince,
        due_at_days:    eligibility.dueAtDays,
        days_until_due: eligibility.daysUntilDue,
        is_due:         eligibility.isDue,
        now_utc:        now.toISOString(),
      })

      // All FUs sent — consider dead-marking when reactivation is disabled.
      // When reactivation is enabled, the reactivation agent handles dead-marking instead.
      if (eligibility.nextFuType === null) {
        const fu3Email = emailsList.find((email) => email.type === 'follow_up_3' && isFuEmailSent(email))
        if (!reactivationEnabled && fu3Email?.sent_at && fu3Email.sent_at < today.start && eligibility.daysSince >= followUp3Days) {
          await supabase.from('leads').update({ status: 'dead' }).eq('id', lead.id)
          await supabase.from('activity_log').insert({
            event_type: 'lead_marked_dead',
            lead_id: lead.id,
            description: `Lead marked as dead: ${lead.business_name} (${eligibility.daysSince} days no reply)`,
            metadata: { days_since: eligibility.daysSince },
          })
          logger.info('followup', `Marked dead: ${lead.business_name}`, { daysSince: eligibility.daysSince })
          markedDead++
          continue
        }
        skipAllSent++
        continue
      }

      const candidate = { lead, initialEmail, daysSince: eligibility.daysSince }

      if (eligibility.isDue) {
        queues[eligibility.nextFuType].push(candidate)
      } else {
        skipNotYetDue++
        logger.info('followup', '[FU_SKIP] not yet due', {
          lead_id:        lead.id,
          lead_name:      lead.business_name,
          days_since:     eligibility.daysSince,
          days_until_due: eligibility.daysUntilDue,
          next_fu_type:   eligibility.nextFuType,
          due_at_days:    eligibility.dueAtDays,
        })
      }
    }

    logger.info('followup', '[FU_ELIGIBILITY] queue build complete', {
      contacted_leads_total: contactedLeads.length,
      fu1_eligible:   queues.follow_up_1.length,
      fu2_eligible:   queues.follow_up_2.length,
      fu3_eligible:   queues.follow_up_3.length,
      marked_dead:    markedDead,
      skip_no_email:        skipNoEmail,
      skip_no_initial:      skipNoInitialEmail,
      skip_not_yet_due:     skipNotYetDue,
      skip_all_sent:        skipAllSent,
    })

    logger.info('followup', '[FOLLOWUP_QUEUE]', {
      pending_follow_up_1: queues.follow_up_1.length,
      pending_follow_up_2: queues.follow_up_2.length,
      pending_follow_up_3: queues.follow_up_3.length,
      limits,
      sent_before_run: sentBeforeRun,
      remaining,
      today_range: today,
    })

    // Phase B: Independent allocation — each queue gets min(eligible, queueLimit)
    // without competing for a shared pool. A single global cap is applied afterwards.
    const allocation = {
      follow_up_1: Math.min(queues.follow_up_1.length, limits.follow_up_1),
      follow_up_2: Math.min(queues.follow_up_2.length, limits.follow_up_2),
      follow_up_3: Math.min(queues.follow_up_3.length, limits.follow_up_3),
    } satisfies Record<FollowUpType, number>

    const totalRequested = allocation.follow_up_1 + allocation.follow_up_2 + allocation.follow_up_3
    const finalAllocation = { ...allocation } as Record<FollowUpType, number>

    if (totalRequested > remainingGlobalToday) {
      let budget = remainingGlobalToday
      for (const type of ['follow_up_1', 'follow_up_2', 'follow_up_3'] as FollowUpType[]) {
        const take = Math.min(finalAllocation[type], budget)
        finalAllocation[type] = take
        budget -= take
      }
    }

    const finalTotal = finalAllocation.follow_up_1 + finalAllocation.follow_up_2 + finalAllocation.follow_up_3

    logger.info('followup', '[OUTBOUND_ALLOCATION]', {
      configuredGlobalLimit,
      alreadySentToday:      alreadySentToday ?? 0,
      remainingGlobalToday,
      allocation,
      totalRequested,
      finalAllocation,
      finalTotal,
    })

    logger.info('followup', '[FOLLOWUP_SUMMARY]', {
      configuredGlobalLimit,
      alreadySentToday:  alreadySentToday ?? 0,
      remainingGlobalToday,
      allocation,
      finalAllocation,
      totalAllocated:    finalTotal,
      skippedNotDue:     skipNotYetDue,
      skippedMissingEmail: skipNoEmail + skipNoInitialEmail,
      skippedAlreadySent:  skipAllSent,
    })

    const sent = {
      follow_up_1: 0,
      follow_up_2: 0,
      follow_up_3: 0,
    } satisfies Record<FollowUpType, number>

    let globalSentThisRun = 0

    for (const type of ['follow_up_1', 'follow_up_2', 'follow_up_3'] as FollowUpType[]) {
      const fuLabel = type === 'follow_up_1' ? 'FU1' : type === 'follow_up_2' ? 'FU2' : 'FU3'
      const toSend  = queues[type].slice(0, finalAllocation[type])

      logger.info('followup', `[PIPELINE_STAGE] ${fuLabel} starting`)
      logger.info('followup', `[${fuLabel}_DEBUG]`, {
        eligible:       queues[type].length,
        limit:          limits[type],
        sentToday:      sentBeforeRun[type],
        allocated:      allocation[type],
        finalAllocated: finalAllocation[type],
      })

      for (const candidate of toSend) {
        const wasSent = await sendFollowUp(supabase, candidate, type)
        if (wasSent) {
          sent[type]++
          globalSentThisRun++
        }
      }

      logger.info('followup', `[${fuLabel}_DEBUG] ${fuLabel} done`, {
        sent:               sent[type],
        global_sent_so_far: globalSentThisRun,
      })
      logger.info('followup', `[PIPELINE_STAGE] ${fuLabel} complete`, { sent: sent[type] })
    }

    logger.info('followup', '[FOLLOWUP_SENT]', {
      sent_follow_up_1: sent.follow_up_1,
      sent_follow_up_2: sent.follow_up_2,
      sent_follow_up_3: sent.follow_up_3,
    })

    logger.info('followup', '[FOLLOWUP_SEND_COMPLETE]', {
      sentFU1:   sent.follow_up_1,
      sentFU2:   sent.follow_up_2,
      sentFU3:   sent.follow_up_3,
      totalSent: sent.follow_up_1 + sent.follow_up_2 + sent.follow_up_3,
    })

    await supabase.from('activity_log').insert({
      event_type: 'followup_complete',
      description: `Follow-up agent done. FU1: ${sent.follow_up_1}, FU2: ${sent.follow_up_2}, FU3: ${sent.follow_up_3}, Dead: ${markedDead}`,
      metadata: {
        follow_up_1_sent: sent.follow_up_1,
        follow_up_2_sent: sent.follow_up_2,
        follow_up_3_sent: sent.follow_up_3,
        marked_dead: markedDead,
        limits,
        pending: {
          follow_up_1: queues.follow_up_1.length,
          follow_up_2: queues.follow_up_2.length,
          follow_up_3: queues.follow_up_3.length,
        },
      },
    })

    logger.info('followup', 'Done', {
      followUp1Sent: sent.follow_up_1,
      followUp2Sent: sent.follow_up_2,
      followUp3Sent: sent.follow_up_3,
      markedDead,
    })
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
