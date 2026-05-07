import { createServiceClient } from '@/lib/supabase/server'
import { writeOutreachEmail, writeOutreachDM } from '@/lib/claude'
import { emailBodyToHtml } from '@/lib/utils'
import { logger } from '@/lib/logger'

export async function runWriterAgent(): Promise<void> {
  logger.info('writer', 'Writer agent starting')

  const supabase = createServiceClient()

  try {
  const { data: systemSetting, error: settingErr } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'system_active')
    .single()

  logger.info('writer', `system_active = "${systemSetting?.value}"`, { err: settingErr?.message ?? 'none' })

  if (systemSetting?.value !== 'true') {
    logger.info('writer', 'System paused — writer skipped')
    return
  }

  // Read daily DM limit
  const { data: dmLimitSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'daily_dm_limit')
    .single()

  const dailyDmLimit = parseInt(dmLimitSetting?.value ?? '10', 10)

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const { count: todayDmCount } = await supabase
    .from('dm_queue')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', todayStart.toISOString())

  let dmsAddedToday = todayDmCount ?? 0
  logger.info('writer', `DM limit: ${dailyDmLimit}, already queued today: ${dmsAddedToday}`)

  // Reset stale email_ready leads (no pending_send email) back to researched
  const { data: emailReadyLeads } = await supabase
    .from('leads')
    .select('id')
    .eq('status', 'email_ready')

  if (emailReadyLeads?.length) {
    const emailReadyIds = emailReadyLeads.map((l: { id: string }) => l.id)
    const { data: emailsWithPending } = await supabase
      .from('emails')
      .select('lead_id')
      .in('lead_id', emailReadyIds)
      .eq('status', 'pending_send')

    const withPendingSet = new Set(emailsWithPending?.map((e: { lead_id: string }) => e.lead_id) ?? [])
    const toReset = emailReadyIds.filter((id: string) => !withPendingSet.has(id))

    if (toReset.length) {
      logger.info('writer', `Resetting ${toReset.length} stale email_ready leads back to researched`)
      const { error: resetErr } = await supabase.from('leads').update({ status: 'researched' }).in('id', toReset)
      if (resetErr) logger.error('writer', 'Reset error', { error: resetErr.message })
    }
  }

  // Fetch all researched leads
  const { data: leads, error: leadsErr } = await supabase
    .from('leads')
    .select('*, categories(*)')
    .eq('status', 'researched')

  if (leadsErr) logger.error('writer', 'Error fetching researched leads', { error: leadsErr.message })

  if (!leads?.length) {
    logger.info('writer', 'No researched leads found — nothing to process')
    return
  }

  logger.info('writer', `${leads.length} researched leads`, {
    withEmail: leads.filter(l => l.email).length,
    instagramOnly: leads.filter(l => !l.email && l.instagram_handle).length,
  })

  let processed = 0
  let emailsQueued = 0
  let dmsQueued = 0
  let deadCount = 0

  // Template cache: one Claude call per category/contentType/city per run (~7 calls instead of ~40)
  type EmailTemplate = { subject: string; body: string; templateName: string; templateSuburb: string }
  const templateCache = new Map<string, EmailTemplate>()
  let cacheHits = 0
  let cacheMisses = 0

  for (const lead of leads) {
    const hasEmail = !!lead.email
    const hasInstagram = !!lead.instagram_handle  // Instagram only — no Facebook

    logger.info('writer', `"${lead.business_name}"`, { email: lead.email ?? 'NONE', instagram: lead.instagram_handle ?? 'NONE' })

    // No contact at all — mark dead, skip Claude calls
    if (!hasEmail && !hasInstagram) {
      logger.info('writer', `Dead (no email, no instagram): "${lead.business_name}"`)
      await supabase.from('leads').update({ status: 'dead' }).eq('id', lead.id)
      await supabase.from('activity_log').insert({
        event_type: 'lead_dead',
        lead_id: lead.id,
        description: `No email and no Instagram — marked dead: ${lead.business_name}`,
      })
      deadCount++
      continue
    }

    try {
      const VISIT_ELIGIBLE = [
        'Halal Restaurants', 'Halal Cafes', 'Halal Bakeries / Dessert Shops',
        'Nail Salons', 'Hair Salons', 'Beauty / Lash Studios',
        'Spas / Massage Studios', 'Hotels / Resorts',
      ]
      const isSydney = lead.city?.toLowerCase() === 'sydney'
      const contentType = (isSydney && VISIT_ELIGIBLE.includes(lead.category_name)) ? 'visit' : 'remote'

      if (hasEmail) {
        // ── Email path ──────────────────────────────────────────────────────
        const cacheKey = `${lead.category_name}_${contentType}_${lead.city}`
        const cached = templateCache.get(cacheKey)
        let emailResult: { subject: string; body: string }

        if (cached) {
          // Reuse cached template: replace previous business name + suburb with this lead's
          const newName = lead.business_name
          const newSuburb = lead.suburb ?? ''
          emailResult = {
            subject: cached.subject.replaceAll(cached.templateName, newName),
            body: cached.templateSuburb
              ? cached.body.replaceAll(cached.templateName, newName).replaceAll(cached.templateSuburb, newSuburb)
              : cached.body.replaceAll(cached.templateName, newName),
          }
          cacheHits++
        } else {
          emailResult = await writeOutreachEmail({
            business_name: lead.business_name,
            category: lead.category_name,
            suburb: lead.suburb ?? '',
            city: lead.city,
            website: lead.website ?? '',
            description: lead.description ?? '',
            services: lead.services ?? '',
            content_type: contentType,
          })
          templateCache.set(cacheKey, {
            ...emailResult,
            templateName: lead.business_name,
            templateSuburb: lead.suburb ?? '',
          })
          cacheMisses++
        }

        logger.info('writer', `Email written for "${lead.business_name}"`, { subject: emailResult.subject })

        const { error: insertErr } = await supabase.from('emails').insert({
          lead_id: lead.id,
          type: 'initial_pitch',
          subject: emailResult.subject,
          body_html: emailBodyToHtml(emailResult.body),
          body_text: emailResult.body,
          status: 'pending_send',
        })

        if (insertErr) {
          logger.error('writer', `Email insert failed for "${lead.business_name}" (${lead.email})`, { error: insertErr.message, code: insertErr.code })
        } else {
          logger.info('writer', `Email queued for "${lead.business_name}" (${lead.email})`)
          await supabase.from('leads').update({ status: 'email_ready' }).eq('id', lead.id)
          emailsQueued++
        }
      } else {
        // ── Instagram/Facebook DM path ──────────────────────────────────────
        if (dmsAddedToday >= dailyDmLimit) {
          logger.info('writer', `DM limit reached (${dailyDmLimit}) — skipping DM for "${lead.business_name}"`)
          continue
        }

        const dmText = await writeOutreachDM({
          business_name: lead.business_name,
          suburb: lead.suburb ?? '',
          city: lead.city,
          category: lead.category_name,
        })

        let dmInserted = false

        if (lead.instagram_handle && dmsAddedToday < dailyDmLimit) {
          // Dedup: skip if this lead or handle already has a pending DM
          const { data: existing } = await supabase
            .from('dm_queue')
            .select('id')
            .or(`lead_id.eq.${lead.id},handle.eq.${lead.instagram_handle}`)
            .limit(1)

          if (existing?.length) {
            logger.info('writer', `Skip DM for "${lead.business_name}" — already in dm_queue`)
          } else {
            const { error: igErr } = await supabase.from('dm_queue').insert({
              lead_id: lead.id,
              platform: 'instagram',
              handle: lead.instagram_handle,
              message_text: dmText,
              status: 'pending',
            })
            if (igErr) {
              logger.error('writer', `Instagram DM insert failed for "${lead.business_name}"`, { error: igErr.message })
            } else {
              dmInserted = true
              dmsAddedToday++
              dmsQueued++
              logger.info('writer', `Instagram DM queued for "${lead.business_name}"`, { handle: lead.instagram_handle })
            }
          }
        }

        if (dmInserted) {
          await supabase.from('leads').update({ status: 'dm_queued' }).eq('id', lead.id)
        }
      }

      await supabase.from('activity_log').insert({
        event_type: 'outreach_written',
        lead_id: lead.id,
        description: `Outreach written: ${lead.business_name} (${hasEmail ? 'email' : 'dm'})`,
        metadata: { channel: hasEmail ? 'email' : 'instagram' },
      })

      processed++
    } catch (error) {
      logger.error('writer', `Exception for "${lead.business_name}"`, { error: String(error) })
      await supabase.from('activity_log').insert({
        event_type: 'writer_error',
        lead_id: lead.id,
        description: `Error writing for: ${lead.business_name}`,
        metadata: { error: String(error) },
      })
    }
  }

  const totalClaudeCalls = cacheMisses + cacheHits
  const writingCost = (cacheMisses * 0.001).toFixed(4)
  logger.info('writer', 'Done', { emailsQueued, dmsQueued, deadCount })
  logger.info('writer', `Claude calls made: ${totalClaudeCalls} (cached: ${cacheHits}, fresh: ${cacheMisses})`)
  logger.info('writer', `Estimated writing cost: $${writingCost}`)

  await supabase.from('activity_log').insert({
    event_type: 'writer_complete',
    description: `Writer complete: ${emailsQueued} emails, ${dmsQueued} DMs, ${deadCount} dead`,
    metadata: {
      emails_queued: emailsQueued,
      dms_queued: dmsQueued,
      dead_count: deadCount,
      total_processed: processed,
      claude_calls_fresh: cacheMisses,
      claude_calls_cached: cacheHits,
      estimated_writing_cost: writingCost,
    },
  })

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('writer', 'Fatal error', { error: message, stack: error instanceof Error ? error.stack : null })
    await supabase.from('activity_log').insert({
      event_type: 'agent_error',
      description: `Agent failed: ${message}`,
      metadata: {
        agent: 'writer',
        error: message,
        stack: error instanceof Error ? error.stack : null,
        timestamp: new Date().toISOString(),
      },
    })
    throw error
  }
}
