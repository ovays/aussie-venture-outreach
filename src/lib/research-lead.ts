import { createServiceClient } from '@/lib/supabase/server'
import { extractWebsiteData, agenticEmailSearch } from '@/lib/claude'
import { logger } from '@/lib/logger'
import {
  HALAL_QUALIFICATION_THRESHOLD,
  isHalalFilterCategory,
  scoreHalalQualification,
} from '@/lib/halalQualification'
import type { HalalQualificationResult } from '@/lib/halalQualification'
import { fetchRawHtml, extractMailtoEmail } from '@/lib/email-extraction'

export type ResearchableLeadRow = {
  id: string
  business_name: string
  category_name: string | null
  website: string | null
  email: string | null
  halal_confidence_score: number | null
  google_reviews_count: number | null
}

export type ResearchOneLeadResult =
  | {
      success: true
      updatedFields: {
        email: string | null
        description: string | null
        services: string | null
        instagram_handle: string | null
        facebook_url: string | null
        halal_confidence_score: number | null
      }
      emailFound: boolean
      emailMethod: string
      emailRounds: number
      halalConfidence: HalalQualificationResult | null
    }
  | { success: false; error: string }

export async function researchOneLead(
  supabase: ReturnType<typeof createServiceClient>,
  lead: ResearchableLeadRow,
): Promise<ResearchOneLeadResult> {
  try {
    let websiteText = ''
    let rawHtml = ''
    let foundEmail: string | null = lead.email ?? null
    let emailMethod = 'outscraper'
    let emailRounds = 0

    if (lead.website) {
      try {
        rawHtml = await fetchRawHtml(lead.website)
        websiteText = rawHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 5000)
      } catch {
        logger.info('researcher', `Could not fetch website for "${lead.business_name}"`)
      }
    }

    if (!foundEmail && rawHtml) {
      const mailtoEmail = extractMailtoEmail(rawHtml)
      if (mailtoEmail) {
        foundEmail = mailtoEmail
        emailMethod = 'mailto_link'
        logger.info('researcher', `Found email via mailto for "${lead.business_name}"`, { email: mailtoEmail })
      }
    }

    const finderQualified =
      isHalalFilterCategory(lead.category_name) && lead.halal_confidence_score != null

    if (finderQualified) {
      logger.info('researcher', 'RESEARCHER_SKIPPED_REQUALIFICATION', {
        lead_id: lead.id,
        business_name: lead.business_name,
        category: lead.category_name,
        halal_confidence_score: lead.halal_confidence_score,
        threshold: HALAL_QUALIFICATION_THRESHOLD,
      })
    }

    const shouldScoreHalal = !finderQualified && isHalalFilterCategory(lead.category_name)
    if (!isHalalFilterCategory(lead.category_name)) {
      logger.info('researcher', `Skipping halal qualification for category: ${lead.category_name}`)
    }
    const halalConfidence = shouldScoreHalal
      ? scoreHalalQualification({
          name: lead.business_name,
          categories: [lead.category_name ?? ''],
          websiteText: websiteText || rawHtml,
          websiteUrl: lead.website,
          reviewTexts: [],
          reviews: lead.google_reviews_count ?? 0,
        })
      : null

    if (halalConfidence) {
      const halalMeta = {
        lead_id: lead.id,
        business_name: lead.business_name,
        category: lead.category_name,
        halal_confidence_score: halalConfidence.confidence,
        positive_keywords: halalConfidence.reasons,
        negative_keywords: halalConfidence.negativeSignals,
      }
      if (halalConfidence.confidence >= 70) {
        logger.info('researcher', 'HALAL_CONFIDENCE_HIGH', halalMeta)
      }
      logger.info('researcher', '[DEBUG_HALAL_CONFIDENCE] detected positive keywords', halalMeta)
      logger.info('researcher', '[DEBUG_HALAL_CONFIDENCE] detected negative keywords', halalMeta)
      logger.info('researcher', 'HALAL_CONFIDENCE_RECORDED', halalMeta)
    }

    if (!foundEmail && lead.website && websiteText) {
      logger.info('researcher', `Starting agentic email search for "${lead.business_name}"`)
      const result = await agenticEmailSearch({
        business_name: lead.business_name,
        website_url: lead.website,
        category: lead.category_name ?? '',
        homepage_content: websiteText,
      })
      if (result.email) {
        foundEmail = result.email
        logger.info('researcher', `Found email via ${result.method} in ${result.rounds} round(s)`, { email: result.email })
      } else {
        logger.info('researcher', `No email found for "${lead.business_name}" after ${result.rounds} round(s)`)
      }
      emailMethod = result.method
      emailRounds = result.rounds
    } else if (foundEmail) {
      emailMethod = 'outscraper'
    } else {
      emailMethod = 'no_website'
    }

    let enriched = {
      description: '',
      services: '',
      instagram_handle: null as string | null,
      facebook_url: null as string | null,
      other_social: null as string | null,
    }
    if (websiteText) {
      enriched = await extractWebsiteData(websiteText)
    }
    if (!enriched.instagram_handle && lead.business_name) {
      const cleanName = lead.business_name.toLowerCase().replace(/[^a-z0-9]/g, '')
      enriched.instagram_handle = `@${cleanName}`
    }

    const { error: updateErr } = await supabase
      .from('leads')
      .update({
        ...(foundEmail && !lead.email ? { email: foundEmail } : {}),
        ...(halalConfidence ? { halal_confidence_score: halalConfidence.confidence } : {}),
        description: enriched.description || null,
        services: enriched.services || null,
        instagram_handle: enriched.instagram_handle || null,
        facebook_url: enriched.facebook_url || null,
        status: 'researched',
      })
      .eq('id', lead.id)

    if (updateErr) {
      logger.error('researcher', `Lead update failed for "${lead.business_name}"`, { error: updateErr.message })
    }

    await supabase.from('activity_log').insert({
      event_type: 'lead_researched',
      lead_id: lead.id,
      description: `Researched: ${lead.business_name} | email: ${foundEmail ? 'found' : 'not found'} via ${emailMethod}`,
      metadata: {
        email_found: !!foundEmail,
        email_method: emailMethod,
        email_rounds: emailRounds,
        halal_confidence_score: halalConfidence?.confidence ?? null,
        halal_positive_keywords: halalConfidence?.reasons ?? [],
        halal_negative_keywords: halalConfidence?.negativeSignals ?? [],
        has_instagram: !!enriched.instagram_handle,
        has_website: !!lead.website,
      },
    })

    return {
      success: true,
      updatedFields: {
        email: (foundEmail && !lead.email) ? foundEmail : (lead.email ?? null),
        description: enriched.description || null,
        services: enriched.services || null,
        instagram_handle: enriched.instagram_handle || null,
        facebook_url: enriched.facebook_url || null,
        halal_confidence_score: halalConfidence
          ? halalConfidence.confidence
          : (lead.halal_confidence_score ?? null),
      },
      emailFound: !!(foundEmail && !lead.email),
      emailMethod,
      emailRounds,
      halalConfidence,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error('researcher', `Exception for "${lead.business_name}": ${msg}`)

    await supabase.from('activity_log').insert({
      event_type: 'agent_error',
      lead_id: lead.id,
      description: `Error researching: ${lead.business_name}: ${msg}`,
      metadata: { error: msg },
    })

    // Mark researched so the writer agent can still attempt this lead
    await supabase.from('leads').update({ status: 'researched' }).eq('id', lead.id)

    return { success: false, error: msg }
  }
}
