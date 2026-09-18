import { createServiceClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { fetchRawHtml, extractMailtoEmail } from '@/lib/email-extraction'
import { researchLead, researchPurposeForMode } from '@/services/research'
import type { InitialEmailMode } from '@/lib/settingsDefaults'
import { BOUNCED_EMAIL_REPAIR_BATCH_SIZE, RESEARCHER_BATCH_SIZE } from '@/lib/agent-batches'
import { decideNextAction, loadDecisionContexts } from '@/domain/decision-engine'
import { observability } from '@/lib/observability/service'

// ── Bounced email fixer ──────────────────────────────────────────────────────

async function fixBouncedEmails(supabase: ReturnType<typeof createServiceClient>): Promise<void> {
  const { data: bouncedEmails } = await supabase
    .from('emails')
    .select('id, lead_id, leads(id, email, website, business_name)')
    .eq('status', 'bounced')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(BOUNCED_EMAIL_REPAIR_BATCH_SIZE)

  if (!bouncedEmails?.length) {
    logger.info('researcher', 'No bounced emails to fix')
    return
  }

  logger.info('researcher', `Found ${bouncedEmails.length} bounced email(s) — attempting to re-extract`)

  for (const emailRecord of bouncedEmails) {
    const lead = emailRecord.leads as unknown as { id: string; email: string | null; website: string | null; business_name: string } | null
    if (!lead?.website) continue

    try {
      let html = await fetchRawHtml(lead.website)
      let newEmail = extractMailtoEmail(html)

      // Try /contact page if homepage didn't yield anything
      if (!newEmail) {
        const base = lead.website.replace(/\/$/, '')
        html = await fetchRawHtml(`${base}/contact`).catch(() => '')
        newEmail = html ? extractMailtoEmail(html) : null
      }

      if (!newEmail || newEmail === lead.email) continue

      logger.info('researcher', `Fixed bounced email for ${lead.business_name}`, { old: lead.email, new: newEmail })

      // Preserve the bounced row as immutable delivery history. Moving the
      // lead back through the writer creates a fresh pending row for the new
      // address; it must never weaken bounced -> pending_send.
      await supabase.from('leads').update({ email: newEmail, status: 'researched' }).eq('id', lead.id)

      await supabase.from('activity_log').insert({
        event_type: 'email_fixed',
        lead_id: lead.id,
        description: `Bounced email corrected for ${lead.business_name}: ${lead.email} → ${newEmail}`,
        metadata: { old_email: lead.email, new_email: newEmail, bounced_email_id: emailRecord.id },
      })
    } catch (err) {
      logger.error('researcher', `Error fixing bounced email for lead`, { lead_id: emailRecord.lead_id, error: String(err) })
    }
  }
}

export async function runResearcherAgent(mode: InitialEmailMode = 'ai_personalised'): Promise<number> {
  const supabase = createServiceClient()
  const researchPurpose = researchPurposeForMode(mode)

  try {
    const { data: systemSetting } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'system_active')
      .single()

    if (systemSetting?.value !== 'true') {
      logger.info('researcher', 'System paused - skipped')
      return 0
    }

    // Fix any bounced emails from previous sends before processing new leads
    await fixBouncedEmails(supabase)

    const { data: leads } = await supabase
      .from('leads')
      .select('id,business_name,email,website,instagram_handle,facebook_url,phone,address,suburb,city,state,category_id,category_name,description,services,content_type,halal,halal_confidence_score,halal_reasons,google_reviews_count,status,source,delivery_suppressed_emails,outreach_suppressed_at,outreach_suppression_reason,created_at,updated_at')
      .eq('status', 'new')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(RESEARCHER_BATCH_SIZE)

    logger.info('researcher', `Found ${leads?.length ?? 0} leads with status=new`)

    if (!leads?.length) {
      logger.info('researcher', 'Nothing to process')
      return 0
    }

    const loadedContexts = await loadDecisionContexts(supabase, leads.map((lead) => lead.id), { initialEmailMode: mode })
    const decisionByLeadId = new Map(loadedContexts.contexts.map((context) => [context.leadId, decideNextAction(context)]))
    await observability().recordDecisionResults([...decisionByLeadId.values()], 'research_decision', 21)
    const templateReadyIds = loadedContexts.contexts
      .filter((context) => decisionByLeadId.get(context.leadId)?.action === 'GENERATE_INITIAL')
      .map((context) => context.leadId)
    if (templateReadyIds.length > 0) {
      const { data: advancedLeads, error: advanceError } = await supabase.from('leads').update({ status: 'researched' }).in('id', templateReadyIds).eq('status', 'new').select('id')
      if (advanceError) throw new Error(`Template-ready lead advancement failed: ${advanceError.message}`)
      await observability().observeLeadStatusTransitions((advancedLeads ?? []).map((lead) => ({
        leadId: lead.id, fromStatus: 'new', toStatus: 'researched', actor: 'researcher', reasonCode: 'TEMPLATE_READY',
      })))
      await supabase.from('activity_log').insert(templateReadyIds.map((leadId) => ({
        event_type: 'research_skipped_template_ready',
        lead_id: leadId,
        description: 'Research skipped because template mode already has all required lead data',
        metadata: { decision_action: 'GENERATE_INITIAL', decision_reason: decisionByLeadId.get(leadId)?.reasonCode ?? 'TEMPLATE_READY' },
      })))
    }

    let processed = templateReadyIds.length
    let emailsFound = 0
    const methodCounts: Record<string, number> = {}

    for (const lead of leads) {
      const decision = decisionByLeadId.get(lead.id)
      if (decision?.action !== 'RESEARCH') continue
      logger.info('researcher', `Lead: "${lead.business_name}"`, {
        email: lead.email ?? 'NONE',
        website: lead.website ?? 'NONE',
      })

      const result = await researchLead({ client: supabase, leadId: lead.id, purpose: researchPurpose })
      if (result.outcome === 'completed') {
        if (result.emailFound) emailsFound++
        const method = result.summary?.emailMethod ?? 'unknown'
        methodCounts[method] = (methodCounts[method] ?? 0) + 1
        processed++
      }
    }

    logger.info('researcher', `Done: ${processed} leads processed, ${emailsFound} emails found`, { methodCounts })

    await supabase.from('activity_log').insert({
      event_type: 'researcher_complete',
      description: `Researcher agent completed — ${processed} leads, ${emailsFound} emails found`,
      metadata: { total_processed: processed, emails_found: emailsFound, method_counts: methodCounts },
    })

    return processed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('researcher', 'Fatal error', { error: message, stack: error instanceof Error ? error.stack : null })
    await supabase.from('activity_log').insert({
      event_type: 'agent_error',
      description: `Agent failed: ${message}`,
      metadata: {
        agent: 'researcher',
        error: message,
        stack: error instanceof Error ? error.stack : null,
        timestamp: new Date().toISOString(),
      },
    })
    throw error
  }
}
