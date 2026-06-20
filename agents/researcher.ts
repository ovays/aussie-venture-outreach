import { createServiceClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { fetchRawHtml, extractMailtoEmail } from '@/lib/email-extraction'
import { researchOneLead } from '@/lib/research-lead'

// ── Bounced email fixer ──────────────────────────────────────────────────────

async function fixBouncedEmails(supabase: ReturnType<typeof createServiceClient>): Promise<void> {
  const { data: bouncedEmails } = await supabase
    .from('emails')
    .select('id, lead_id, leads(id, email, website, business_name)')
    .eq('status', 'bounced')

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

      await supabase.from('leads').update({ email: newEmail }).eq('id', lead.id)
      await supabase.from('emails').update({ status: 'pending_send' }).eq('id', emailRecord.id)

      await supabase.from('activity_log').insert({
        event_type: 'email_fixed',
        lead_id: lead.id,
        description: `Bounced email corrected for ${lead.business_name}: ${lead.email} → ${newEmail}`,
        metadata: { old_email: lead.email, new_email: newEmail },
      })
    } catch (err) {
      logger.error('researcher', `Error fixing bounced email for lead`, { lead_id: emailRecord.lead_id, error: String(err) })
    }
  }
}

export async function runResearcherAgent(): Promise<number> {
  const supabase = createServiceClient()

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
      .select('*')
      .eq('status', 'new')

    logger.info('researcher', `Found ${leads?.length ?? 0} leads with status=new`)

    if (!leads?.length) {
      logger.info('researcher', 'Nothing to process')
      return 0
    }

    let processed = 0
    let emailsFound = 0
    const methodCounts: Record<string, number> = {}

    for (const lead of leads) {
      logger.info('researcher', `Lead: "${lead.business_name}"`, {
        email: lead.email ?? 'NONE',
        website: lead.website ?? 'NONE',
      })

      const result = await researchOneLead(supabase, lead)
      if (result.success) {
        if (result.emailFound) emailsFound++
        methodCounts[result.emailMethod] = (methodCounts[result.emailMethod] ?? 0) + 1
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
