import { createServiceClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { fetchPipelineDedupeIndex } from '@/lib/deduplication'
import { writeOneLead, type DmState } from '@/lib/write-lead'

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

    const dmState: DmState = { dmsAddedToday: todayDmCount ?? 0, dailyDmLimit }
    logger.info('writer', `DM limit: ${dailyDmLimit}, already queued today: ${dmState.dmsAddedToday}`)

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
      const result = await writeOneLead(supabase, lead, dedupeIndex, dmState)
      if (result.success) {
        if (result.channel === 'email') {
          emailsQueued++
          processed++
        } else if (result.channel === 'dm') {
          if (result.dmQueued) dmsQueued++
          processed++
        } else if (result.channel === 'dead') {
          deadCount++
        } else if (result.channel === 'duplicate') {
          duplicateSkipped++
        }
        // 'dm_limit_reached' — no counter incremented
      }
    }

    logger.info('writer', '[PIPELINE_STAGE] Writer complete', {
      emailsQueued,
      dmsQueued,
      deadCount,
      duplicateSkipped,
      totalProcessed: processed,
    })

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
