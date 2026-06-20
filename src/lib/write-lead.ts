import { createServiceClient } from '@/lib/supabase/server'
import { writeOutreachEmail, writeOutreachDM } from '@/lib/claude'
import { emailBodyToHtml } from '@/lib/utils'
import { logger } from '@/lib/logger'
import { checkLeadDedupe, type LeadDedupeIndex } from '@/lib/deduplication'

export const VISIT_ELIGIBLE_CATEGORIES: string[] = [
  'Halal Restaurants', 'Halal Cafes', 'Halal Bakeries / Dessert Shops',
  'Nail Salons', 'Hair Salons', 'Beauty / Lash Studios',
  'Spas / Massage Studios', 'Hotels / Resorts',
]

export type DmState = {
  dmsAddedToday: number
  dailyDmLimit: number
}

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
}

export type WriteOneLeadResult =
  | { success: true; channel: 'email' | 'dead' | 'duplicate' | 'dm_limit_reached' }
  | { success: true; channel: 'dm'; dmQueued: boolean }
  | { success: false; error: string }

export async function writeOneLead(
  supabase: ReturnType<typeof createServiceClient>,
  lead: WriteableLeadRow,
  dedupeIndex: LeadDedupeIndex,
  dmState: DmState,
): Promise<WriteOneLeadResult> {
  const hasEmail = !!lead.email
  const hasInstagram = !!lead.instagram_handle

  logger.info('writer', `"${lead.business_name}"`, {
    email: lead.email ?? 'NONE',
    instagram: lead.instagram_handle ?? 'NONE',
  })

  if (!hasEmail && !hasInstagram) {
    logger.info('writer', `Dead (no email, no instagram): "${lead.business_name}"`)
    await supabase.from('leads').update({ status: 'dead' }).eq('id', lead.id)
    await supabase.from('activity_log').insert({
      event_type: 'lead_dead',
      lead_id: lead.id,
      description: `No email and no Instagram — marked dead: ${lead.business_name}`,
    })
    return { success: true, channel: 'dead' }
  }

  try {
    const isSydney = lead.city?.toLowerCase() === 'sydney'
    const contentType =
      isSydney && VISIT_ELIGIBLE_CATEGORIES.includes(lead.category_name ?? '')
        ? 'visit'
        : 'remote'

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
      await supabase.from('leads').update({ status: 'email_ready' }).eq('id', lead.id)
      await supabase.from('activity_log').insert({
        event_type: 'outreach_written',
        lead_id: lead.id,
        description: `Outreach written: ${lead.business_name} (email)`,
        metadata: { channel: 'email' },
      })
      return { success: true, channel: 'email' }
    } else {
      // Instagram DM path
      if (dmState.dmsAddedToday >= dmState.dailyDmLimit) {
        logger.info('writer', `DM limit reached (${dmState.dailyDmLimit}) — skipping DM for "${lead.business_name}"`)
        return { success: true, channel: 'dm_limit_reached' }
      }

      const dmText = await writeOutreachDM({
        business_name: lead.business_name,
        suburb: lead.suburb ?? '',
        city: lead.city as string,
        category: lead.category_name as string,
      })

      let dmInserted = false

      if (lead.instagram_handle && dmState.dmsAddedToday < dmState.dailyDmLimit) {
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
            logger.error('writer', `Instagram DM insert failed for "${lead.business_name}"`, {
              error: igErr.message,
            })
          } else {
            dmInserted = true
            dmState.dmsAddedToday++
            logger.info('writer', `Instagram DM queued for "${lead.business_name}"`, {
              handle: lead.instagram_handle,
            })
          }
        }
      }

      if (dmInserted) {
        await supabase.from('leads').update({ status: 'dm_queued' }).eq('id', lead.id)
      }

      await supabase.from('activity_log').insert({
        event_type: 'outreach_written',
        lead_id: lead.id,
        description: `Outreach written: ${lead.business_name} (dm)`,
        metadata: { channel: 'instagram' },
      })

      return { success: true, channel: 'dm', dmQueued: dmInserted }
    }
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
