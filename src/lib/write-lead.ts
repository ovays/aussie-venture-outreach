import { createServiceClient } from '@/lib/supabase/server'
import { writeOutreachEmail } from '@/ai/workflows'
import { emailBodyToHtml } from '@/lib/utils'
import { logger } from '@/lib/logger'
import { addLeadToDedupeIndex, checkLeadDedupe, type LeadDedupeIndex } from '@/lib/deduplication'

export type WriteableLeadRow = {
  id: string
  business_name: string
  category_name: string | null
  suburb: string | null
  city: string | null
  website: string | null
  description: string | null
  services: string | null
  email: string | null
  instagram_handle: string | null
  content_type: string | null
}

export type WriteOneLeadResult =
  | { success: true; channel: 'email' | 'dead' | 'duplicate' }
  | { success: false; error: string }

export async function writeOneLead(
  supabase: ReturnType<typeof createServiceClient>,
  lead: WriteableLeadRow,
  dedupeIndex: LeadDedupeIndex,
): Promise<WriteOneLeadResult> {
  logger.info('writer', `"${lead.business_name}"`, {
    email: lead.email ?? 'NONE',
    instagram: lead.instagram_handle ?? 'NONE',
  })

  if (!lead.email) {
    logger.info('writer', `Skipped (no email): "${lead.business_name}"`, {
      hasInstagram: !!lead.instagram_handle,
    })
    await supabase.from('leads').update({ status: 'dead' }).eq('id', lead.id)
    await supabase.from('activity_log').insert({
      event_type: 'lead_dead',
      lead_id: lead.id,
      description: `No email — skipped outreach generation and marked dead: ${lead.business_name}`,
      metadata: {
        reason: 'no_email',
        has_instagram: !!lead.instagram_handle,
      },
    })
    return { success: true, channel: 'dead' }
  }

  try {
    const contentType = lead.content_type ?? 'remote'

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
      return { success: true, channel: 'duplicate' }
    }

    const emailResult = await writeOutreachEmail({
      business_name: lead.business_name,
      category: lead.category_name as string,
      suburb: lead.suburb ?? '',
      city: lead.city as string,
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
      logger.error('writer', `Email insert failed for "${lead.business_name}"`, {
        error: insertErr.message,
        code: insertErr.code,
      })
      return { success: false, error: `Email insert failed: ${insertErr.message}` }
    }

    logger.info('writer', `Email queued for "${lead.business_name}" (${lead.email})`)
    // Register this lead in the shared dedupe index immediately so any later
    // lead in the same batch that resolves to the same email/root domain
    // (e.g. two Google Maps listings for one franchise) is caught — the
    // index is otherwise fetched once per pipeline run and would go stale
    // mid-batch without this.
    addLeadToDedupeIndex(dedupeIndex, {
      id: lead.id,
      business_name: lead.business_name,
      email: lead.email,
      status: 'email_ready',
    })
    await supabase.from('leads').update({ status: 'email_ready' }).eq('id', lead.id)
    await supabase.from('activity_log').insert({
      event_type: 'outreach_written',
      lead_id: lead.id,
      description: `Outreach written: ${lead.business_name} (email)`,
      metadata: { channel: 'email' },
    })
    return { success: true, channel: 'email' }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error('writer', `Exception for "${lead.business_name}": ${msg}`)
    await supabase.from('activity_log').insert({
      event_type: 'agent_error',
      lead_id: lead.id,
      description: `Error writing for: ${lead.business_name}: ${msg}`,
      metadata: { error: msg },
    })
    return { success: false, error: msg }
  }
}
