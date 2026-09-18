import type { SupabaseClient } from '@supabase/supabase-js'
import type { InitialEmailMode } from '@/lib/settingsDefaults'
import {
  researchOneLead,
  type ResearchOneLeadResult,
  type ResearchableLeadRow,
  type ResearchPurpose as LegacyResearchPurpose,
} from '@/lib/research-lead'

export const RESEARCH_PURPOSES = ['CONTACT_DISCOVERY', 'PERSONALIZATION'] as const
export type ResearchPurpose = (typeof RESEARCH_PURPOSES)[number]

export interface ResearchLeadInput {
  client: SupabaseClient
  leadId: string
  purpose: ResearchPurpose
  research?: typeof researchOneLead
}

export interface ResearchLeadResult {
  outcome: 'completed' | 'failed'
  changedState: boolean
  emailFound?: boolean
  researchCompleted?: boolean
  personalisationCompleted?: boolean
  summary?: {
    emailMethod?: string
    emailRounds?: number
    error?: string
  }
}

const RESEARCH_FIELDS =
  'id,business_name,category_name,website,email,halal_confidence_score,google_reviews_count'

function legacyPurpose(purpose: ResearchPurpose): LegacyResearchPurpose {
  return purpose === 'CONTACT_DISCOVERY' ? 'contact_discovery_only' : 'full_personalisation'
}

export function researchPurposeForMode(mode: InitialEmailMode): ResearchPurpose {
  return mode === 'template' ? 'CONTACT_DISCOVERY' : 'PERSONALIZATION'
}

/** Performs only the requested research for one already-selected lead. */
export async function researchLead(input: ResearchLeadInput): Promise<ResearchLeadResult> {
  const selected = await input.client.from('leads')
    .select(RESEARCH_FIELDS)
    .eq('id', input.leadId)
    .maybeSingle()
  if (selected.error || !selected.data) {
    return {
      outcome: 'failed',
      changedState: false,
      summary: { error: selected.error?.message ?? 'lead_not_found' },
    }
  }

  const execute = input.research ?? researchOneLead
  const result: ResearchOneLeadResult = await execute(
    input.client as Parameters<typeof researchOneLead>[0],
    selected.data as ResearchableLeadRow,
    legacyPurpose(input.purpose),
  )
  if (!result.success) {
    return { outcome: 'failed', changedState: true, summary: { error: result.error } }
  }
  return {
    outcome: 'completed',
    changedState: true,
    emailFound: result.emailFound,
    researchCompleted: true,
    personalisationCompleted: input.purpose === 'PERSONALIZATION',
    summary: { emailMethod: result.emailMethod, emailRounds: result.emailRounds },
  }
}
