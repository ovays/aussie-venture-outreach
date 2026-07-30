// Single source of truth for generating FU1/FU2/FU3 content — used by both
// the live daily sender (agents/followup.ts) and staged-lead import backfill
// (src/app/api/leads/route.ts), so imported and organically-progressed leads
// get byte-identical content from the fixed template system.

import { buildFollowUpEmail } from '@/lib/followup-email-templates'
import type { FollowUpType } from '@/lib/followup-eligibility'

export interface FollowUpThreadEmail {
  type: string
  subject: string
  body: string
}

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

// Retained for source compatibility with callers and tests that previously
// injected the Claude writer. generateFollowUpEmail intentionally ignores it.
export type FollowUpAiGenerator = (params: {
  business_name: string
  category: string
  suburb: string
  city: string
  website: string
  description: string
  services: string
  notes: string
  content_type: string
  follow_up_number: 1 | 2 | 3
  initial_subject: string
  history: FollowUpThreadEmail[]
}) => Promise<{ subject: string; body: string }>

export async function generateFollowUpEmail(
  type: FollowUpType,
  business: FollowUpBusinessContext,
  initialSubject: string,
  _history: FollowUpThreadEmail[],
  _aiGenerator?: FollowUpAiGenerator
): Promise<GeneratedFollowUpEmail> {
  const template = buildFollowUpEmail(
    type,
    business.businessName,
    initialSubject,
    business.category,
    business.contentType
  )
  return { ...template, source: 'template' }
}
