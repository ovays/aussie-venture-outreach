import { computeFollowUpEligibility } from '@/lib/followup-eligibility'
import { decideNextAction } from './decide'
import type { DecisionAction, LeadDecisionContext, LeadDecisionResult } from './types'

export type ShadowDifferenceClassification =
  | 'MATCH'
  | 'EXPECTED_V2_CONSOLIDATION'
  | 'BUG_IN_OLD_LOGIC'
  | 'BUG_IN_NEW_ENGINE'
  | 'PRODUCT_DECISION_REQUIRED'

export interface DecisionShadowComparison {
  engine: LeadDecisionResult
  legacyAction: DecisionAction
  classification: ShadowDifferenceClassification
  note: string
}

export interface LifecycleProjectionDecision {
  next_action: string
  is_overdue: boolean
}

export function deriveLegacyIntendedAction(context: LeadDecisionContext): DecisionAction {
  if (context.suppressed || context.duplicate || context.operationalFacts?.openDuplicateFlag) return 'STOP'
  if (context.status === 'closed' || context.status === 'closed_manual' || context.status === 'dead') return 'STOP'
  if (context.reply.received || context.status === 'replied') {
    if (context.reply.classification === 'UNSUBSCRIBE') return 'STOP'
    if (context.reply.classification === 'OUT_OF_OFFICE') return 'WAIT'
    return 'HANDLE_REPLY'
  }
  if (context.status === 'interested' || context.status === 'negotiating') return 'STOP'
  if (context.manualOverride?.requestedStatus && context.manualOverride.requestedStatus !== context.status) return 'MANUAL_REVIEW'
  if (context.operationalFacts?.manualSource && context.status !== 'contacted') return 'MANUAL_REVIEW'
  if (context.operationalFacts?.recipientOwnership === 'owned_by_other') return 'STOP'
  if (context.initialEmail.state === 'uncertain') return 'MANUAL_REVIEW'
  if (context.status === 'email_ready') return context.initialEmail.state === 'pending' ? 'SEND_INITIAL' : 'MANUAL_REVIEW'
  if (context.initialEmail.state === 'pending') return 'SEND_INITIAL'
  if (context.initialEmailMode === 'template') {
    if (!context.email && context.status === 'new' && !context.research.contactDiscoveryComplete) return 'RESEARCH'
    if (!context.email || !context.template.available) return 'MANUAL_REVIEW'
    if (!context.template.requiredDataAvailable) return context.research.canSupplyTemplateFields ? 'RESEARCH' : 'MANUAL_REVIEW'
    if (context.status === 'new') return 'RESEARCH'
    return 'GENERATE_INITIAL'
  }
  if (context.status === 'new' || !context.research.personalisationComplete) return 'RESEARCH'
  if (!context.email) return 'STOP'
  if (context.status === 'researched') return 'GENERATE_INITIAL'
  if (!context.initialEmail.sentAt) return 'MANUAL_REVIEW'

  const eligibility = computeFollowUpEligibility(
    context.initialEmail.sentAt,
    context.followUps.followUp1.state === 'sent',
    context.followUps.followUp2.state === 'sent',
    context.followUps.followUp3.state === 'sent',
    { fu1Days: context.schedule.followUp1Days, fu2Days: context.schedule.followUp2Days, fu3Days: context.schedule.followUp3Days },
    new Date(context.asOf),
  )
  if (eligibility.nextFuType && eligibility.isDue) {
    return eligibility.nextFuType === 'follow_up_1' ? 'SEND_FOLLOWUP_1'
      : eligibility.nextFuType === 'follow_up_2' ? 'SEND_FOLLOWUP_2' : 'SEND_FOLLOWUP_3'
  }
  if (eligibility.nextFuType) return 'WAIT'
  if (context.reactivation.sentAt) {
    const days = Math.floor((Date.parse(context.asOf) - Date.parse(context.reactivation.sentAt)) / 86_400_000)
    return days >= context.schedule.deadAfterReactivationDays ? 'MARK_DEAD' : 'WAIT'
  }
  if (!context.reactivation.enabled) return 'WAIT'
  return eligibility.daysSince >= context.schedule.reactivationDelayDays ? 'REACTIVATE' : 'WAIT'
}

export function compareDecisionWithLegacy(context: LeadDecisionContext): DecisionShadowComparison {
  const engine = decideNextAction(context)
  const legacy = deriveLegacyIntendedAction(context)
  if (engine.action === legacy) return { engine, legacyAction: legacy, classification: 'MATCH', note: 'The centralized result matches current executable eligibility.' }
  if (context.initialEmailMode === 'template' && context.status === 'new' && engine.action === 'GENERATE_INITIAL' && legacy === 'RESEARCH') {
    return { engine, legacyAction: legacy, classification: 'EXPECTED_V2_CONSOLIDATION', note: 'Template-ready leads skip unnecessary Researcher work.' }
  }
  if (context.followUps.followUp3.state === 'sent' && (context.followUps.followUp1.state !== 'sent' || context.followUps.followUp2.state !== 'sent')) {
    return { engine, legacyAction: legacy, classification: 'BUG_IN_OLD_LOGIC', note: 'Legacy reactivation only checks FU3; the engine requires a valid sequential history.' }
  }
  return { engine, legacyAction: legacy, classification: 'PRODUCT_DECISION_REQUIRED', note: 'The difference is not an approved consolidation and must not drive side effects without review.' }
}

export function compareDecisionWithLifecycleProjection(
  context: LeadDecisionContext,
  projection: LifecycleProjectionDecision,
): DecisionShadowComparison {
  const engine = decideNextAction(context)
  let projected: DecisionAction = 'STOP'
  if (!projection.is_overdue && projection.next_action !== 'None') projected = 'WAIT'
  else if (projection.next_action === 'Send Follow-up 1') projected = 'SEND_FOLLOWUP_1'
  else if (projection.next_action === 'Send Follow-up 2') projected = 'SEND_FOLLOWUP_2'
  else if (projection.next_action === 'Send Follow-up 3') projected = 'SEND_FOLLOWUP_3'
  else if (projection.next_action === 'Send Reactivation') projected = 'REACTIVATE'
  else if (projection.next_action === 'Mark Dead') projected = 'MARK_DEAD'

  if (engine.action === projected) {
    return { engine, legacyAction: projected, classification: 'MATCH', note: 'The paged lifecycle projection and engine agree.' }
  }
  return {
    engine,
    legacyAction: projected,
    classification: 'PRODUCT_DECISION_REQUIRED',
    note: 'Lifecycle projection differs from the engine; shadow mode does not execute either action.',
  }
}
