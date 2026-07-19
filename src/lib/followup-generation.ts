// Single source of truth for generating FU1/FU2/FU3 content — used by both
// the live daily sender (agents/followup.ts) and staged-lead import backfill
// (src/app/api/leads/route.ts), so imported and organically-progressed leads
// get identical treatment. Tries Claude first, using the full business
// context and email thread history; on any failure (API error, malformed
// response, empty body) falls back to the fixed static template so the
// daily pipeline never stops on a generation failure.

import { logger } from '@/lib/logger'
import { emailBodyToHtml } from '@/lib/utils'
import { writeFollowUpEmail, type FollowUpThreadEmail } from '@/lib/claude'
import { buildFollowUpEmail } from '@/lib/followup-email-templates'
import { FOLLOW_UP_NUMBER } from '@/lib/stage-import'
import type { FollowUpType } from '@/lib/followup-eligibility'

export type { FollowUpThreadEmail }

export interface FollowUpBusinessContext {
  businessName: string
  category: string
  suburb: string
  city: string
  website: string
  description: string
  services: string
  notes: string
  contentType: string
}

export interface GeneratedFollowUpEmail {
  subject: string
  body: string
  html: string
  source: 'ai' | 'template'
}

// Matches writeFollowUpEmail's signature — the default AI generator. Tests
// inject a stub here instead, so generation logic (history passing, stage
// selection, fallback-on-failure) is verifiable without a live API call.
export type FollowUpAiGenerator = typeof writeFollowUpEmail

export async function generateFollowUpEmail(
  type: FollowUpType,
  business: FollowUpBusinessContext,
  initialSubject: string,
  history: FollowUpThreadEmail[],
  aiGenerator: FollowUpAiGenerator = writeFollowUpEmail
): Promise<GeneratedFollowUpEmail> {
  try {
    const ai = await aiGenerator({
      business_name:     business.businessName,
      category:          business.category,
      suburb:            business.suburb,
      city:              business.city,
      website:           business.website,
      description:       business.description,
      services:          business.services,
      notes:             business.notes,
      content_type:      business.contentType,
      follow_up_number:  FOLLOW_UP_NUMBER[type],
      initial_subject:   initialSubject,
      history,
    })
    return { subject: ai.subject, body: ai.body, html: emailBodyToHtml(ai.body), source: 'ai' }
  } catch (err) {
    logger.error('followup-generation', `Claude follow-up generation failed for ${type} — falling back to static template`, {
      error:         err instanceof Error ? err.message : String(err),
      business_name: business.businessName,
    })
    const fallback = buildFollowUpEmail(type, business.businessName, initialSubject, business.category, business.contentType)
    return { ...fallback, source: 'template' }
  }
}
