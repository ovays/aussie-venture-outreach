import { createServiceClient } from '@/lib/supabase/server'
import { writeOutreachEmail, writeOutreachDM } from '@/lib/claude'
import { emailBodyToHtml } from '@/lib/utils'
import { logger } from '@/lib/logger'
import { checkLeadDedupe, fetchPipelineDedupeIndex } from '@/lib/deduplication'

type CategoryStatusRow = {
  name: string
  status: string | null
}

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
    logger.info('writer', '[PIPELINE_STAGE] Writer exiting', { reason: 'system_paused', system_active: systemSetting?.value ?? null })
    return
  }

  // Read daily DM limit
  const { data: dmLimitSetting } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'daily_dm_limit')
    .single()

  const dailyDmLimit = parseInt(dmLimitSetting?.value ?? '10', 10)

  const { data: categoryRows } = await supabase
    .from('categories')
    .select('name, status')
    .order('name')
  const categoryStatusByName = new Map(
    ((categoryRows ?? []) as CategoryStatusRow[]).map((category) => [category.name, category.status])
  )

  logger.info('writer', '[DEBUG_CATEGORY_FILTER] Writer active category filtering', {
    filtersByActiveCategoryStatus: false,
    note: 'Writer fetches researched leads by lead status only; category status is logged for diagnostics.',
  })

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
    logger.info('writer', '[PIPELINE_STAGE] Writer exiting', { reason: 'no_researched_leads' })
    return
  }

  logger.info('writer', `${leads.length} researched leads`, {
    withEmail: leads.filter(l => l.email).length,
    instagramOnly: leads.filter(l => !l.email && l.instagram_handle).length,
  })

  const dedupeIndex = await fetchPipelineDedupeIndex(supabase)
  logger.info('writer', '[DEBUG_DEDUPLICATION] Pipeline dedupe index loaded', {
    emails: dedupeIndex.byEmail.size,
    root_domains: dedupeIndex.byRootDomain.size,
  })

  const researchedByCategory = leads.reduce<Record<string, {
    count: number
    withEmail: number
    instagramOnly: number
    categoryStatus: string | null
  }>>((groups, lead) => {
    const categoryName = lead.category_name ?? '(missing category)'
    if (!groups[categoryName]) {
      groups[categoryName] = {
        count: 0,
        withEmail: 0,
        instagramOnly: 0,
        categoryStatus: categoryStatusByName.get(categoryName) ?? null,
      }
    }
    groups[categoryName].count++
    if (lead.email) groups[categoryName].withEmail++
    if (!lead.email && lead.instagram_handle) groups[categoryName].instagramOnly++
    return groups
  }, {})

  logger.info('writer', '[DEBUG_CATEGORY_FILTER] Researched leads grouped by category', {
    categories: researchedByCategory,
  })

  let processed = 0
  let emailsQueued = 0
  let dmsQueued = 0
  let deadCount = 0
  let duplicateSkipped = 0

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
        const dedupeDecision = checkLeadDedupe(lead.email, dedupeIndex, lead.id)
        if (dedupeDecision.duplicate) {
          const duplicateMeta = {
            candidate_lead_id: lead.id,
            candidate_business_name: lead.business_name,
            candidate_email: dedupeDecision.email,
            root_domain: dedupeDecision.rootDomain,
            existing_lead_id: dedupeDecision.match.id,
            existing_business_name: dedupeDecision.match.businessName,
            existing_email: dedupeDecision.match.email,
            existing_status: dedupeDecision.match.status,
            skipped_reason: dedupeDecision.reason,
          }

          logger.info('writer', dedupeDecision.reason, duplicateMeta)
          if (dedupeDecision.reason === 'DUPLICATE_EMAIL_SKIPPED') {
            logger.info('writer', '[DEBUG_DEDUPLICATION] duplicate email detected', duplicateMeta)
          } else {
            logger.info('writer', '[DEBUG_DEDUPLICATION] duplicate domain detected', duplicateMeta)
          }
          logger.info('writer', '[DEBUG_DEDUPLICATION] lead skipped reason', duplicateMeta)

          await supabase.from('activity_log').insert({
            event_type: dedupeDecision.reason,
            lead_id: lead.id,
            description: `Duplicate skipped before email queueing: ${lead.business_name}`,
            metadata: duplicateMeta,
          })

          duplicateSkipped++
          continue
        }
        // ── Email path ──────────────────────────────────────────────────────
        const emailResult = await writeOutreachEmail({
          business_name: lead.business_name,
          category: lead.category_name,
          suburb: lead.suburb ?? '',
          city: lead.city,
          website: lead.website ?? '',
          description: lead.description ?? '',
          services: lead.services ?? '',
          content_type: contentType,
        })

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
      const msg = error instanceof Error ? error.message : String(error)
      logger.error('writer', `Exception for "${lead.business_name}": ${msg}`)
      await supabase.from('activity_log').insert({
        event_type: 'agent_error',
        lead_id: lead.id,
        description: `Error writing for: ${lead.business_name}: ${msg}`,
        metadata: { error: msg },
      })
    }
  }

  logger.info('writer', '[PIPELINE_STAGE] Writer complete', { emailsQueued, dmsQueued, deadCount, duplicateSkipped, totalProcessed: processed })

  await supabase.from('activity_log').insert({
    event_type: 'writer_complete',
    description: `Writer complete: ${emailsQueued} emails, ${dmsQueued} DMs, ${deadCount} dead`,
    metadata: {
      emails_queued: emailsQueued,
      dms_queued: dmsQueued,
      dead_count: deadCount,
      duplicate_skipped: duplicateSkipped,
      total_processed: processed,
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
