import { createServiceClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { fetchPipelineDedupeIndex } from '@/lib/deduplication'
import { writeOneLead } from '@/lib/write-lead'
import { readInitialEmailMode } from '@/lib/initial-email-router'
import type { InitialEmailMode } from '@/lib/settingsDefaults'
import { loadInitialEmailModeSnapshots } from '@/lib/initial-email-mode-snapshot'

type CategoryStatusRow = {
  name: string
  status: string | null
}

const RECOVERABLE_TEMPLATE_CODES = new Set([
  'missing_category_id', 'category_not_found', 'missing_template', 'empty_subject', 'empty_body',
  'invalid_template', 'missing_lead_value', 'unresolved_placeholder',
])

export async function runWriterAgent(modeSnapshot?: InitialEmailMode): Promise<void> {
  logger.info('writer', 'Writer agent starting')

  const supabase = createServiceClient()
  const mode = modeSnapshot ?? await readInitialEmailMode(supabase)
  logger.info('writer', 'Initial Email Mode captured', { initial_email_mode: mode })

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

    // Reset stale email_ready leads (no pending_send email) back to researched
    const { data: emailReadyLeads } = await supabase
      .from('leads')
      .select('id')
      .eq('status', 'email_ready')

    if (emailReadyLeads?.length) {
      const emailReadyIds = emailReadyLeads.map((l: { id: string }) => l.id)
      const [{ data: emailsWithPending }, { data: emailsWithSyncFailed }] = await Promise.all([
        supabase.from('emails').select('lead_id').in('lead_id', emailReadyIds).eq('status', 'pending_send'),
        // email_sync_failed means the email was delivered but DB sync failed — do NOT reset
        // these leads; they need operator repair, not pipeline re-processing.
        supabase.from('emails').select('lead_id').in('lead_id', emailReadyIds).eq('status', 'email_sync_failed'),
      ])

      const withPendingSet    = new Set(emailsWithPending?.map((e: { lead_id: string }) => e.lead_id) ?? [])
      const withSyncFailedSet = new Set(emailsWithSyncFailed?.map((e: { lead_id: string }) => e.lead_id) ?? [])
      const toReset = emailReadyIds.filter((id: string) => !withPendingSet.has(id) && !withSyncFailedSet.has(id))

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
    const importedModeSnapshots = await loadInitialEmailModeSnapshots(supabase, leads.map((lead) => lead.id))
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
    let deadCount = 0
    let duplicateSkipped = 0
    let templateEmailsCreated = 0
    let skipped = 0
    let failed = 0

    for (const lead of leads) {
      const leadMode = importedModeSnapshots.get(lead.id) ?? mode
      const result = await writeOneLead(supabase, lead, dedupeIndex, leadMode)
      if (result.success) {
        if (result.channel === 'email') {
          emailsQueued++
          processed++
          if (leadMode === 'template' && result.outcome === 'created' && result.generationSource === 'template') {
            templateEmailsCreated++
          }
        } else if (result.channel === 'dead') {
          deadCount++
          skipped++
        } else if (result.channel === 'duplicate') {
          duplicateSkipped++
          skipped++
        }
      } else if (leadMode === 'template' && result.code && RECOVERABLE_TEMPLATE_CODES.has(result.code)) {
        skipped++
      } else {
        failed++
      }
    }

    logger.info('writer', '[PIPELINE_STAGE] Writer complete', {
      emailsQueued,
      deadCount,
      duplicateSkipped,
      totalProcessed: processed,
      initial_email_mode: mode,
      mode,
      researchedLeadsFound: leads.length,
      templateEmailsCreated,
      skipped,
      failed,
    })

    await supabase.from('activity_log').insert({
      event_type: 'writer_complete',
      description: `Writer complete: ${emailsQueued} emails, ${deadCount} dead`,
      metadata: {
        emails_queued: emailsQueued,
        dead_count: deadCount,
        duplicate_skipped: duplicateSkipped,
        total_processed: processed,
        initial_email_mode: mode,
        researched_leads_found: leads.length,
        template_emails_created: templateEmailsCreated,
        skipped,
        failed,
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
