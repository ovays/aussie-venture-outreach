import type { InitialEmailMode } from '@/lib/settingsDefaults'
import { decideNextAction } from './decide'
import { DEFAULT_DECISION_SCHEDULE, type DecisionEmailStage, type LeadDecisionContext, type LeadDecisionResult } from './types'

export interface ContactedOutreachDecisionInput {
  leadId: string
  email: string | null
  suppressed?: boolean
  initialSentAt: string | null
  followUp1: DecisionEmailStage
  followUp2: DecisionEmailStage
  followUp3: DecisionEmailStage
  reactivationEnabled: boolean
  reactivationSentAt: string | null
  asOf: Date
  schedule?: Partial<LeadDecisionContext['schedule']>
  initialEmailMode?: InitialEmailMode
}

export function decideContactedOutreach(input: ContactedOutreachDecisionInput): LeadDecisionResult {
  const context: LeadDecisionContext = {
    leadId: input.leadId,
    status: 'contacted',
    email: input.email,
    duplicate: false,
    suppressed: input.suppressed ?? false,
    dealState: 'none',
    initialEmailMode: input.initialEmailMode ?? 'ai_personalised',
    research: { contactDiscoveryComplete: true, personalisationComplete: true, canSupplyTemplateFields: false },
    template: { available: false, requiredDataAvailable: false },
    initialEmail: input.initialSentAt ? { state: 'sent', sentAt: input.initialSentAt } : { state: 'missing', sentAt: null },
    followUps: { followUp1: input.followUp1, followUp2: input.followUp2, followUp3: input.followUp3 },
    reply: { received: false, classification: null },
    reactivation: { enabled: input.reactivationEnabled, sentAt: input.reactivationSentAt },
    schedule: { ...DEFAULT_DECISION_SCHEDULE, ...input.schedule },
    asOf: input.asOf.toISOString(),
    manualOverride: null,
  }
  return decideNextAction(context)
}

export function sentStage(sentAt: string | null | undefined): DecisionEmailStage {
  return sentAt ? { state: 'sent', sentAt } : { state: 'missing', sentAt: null }
}
