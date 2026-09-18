import type { DecisionAction, DecisionInputKey, DecisionReasonCode, LeadDecisionContext } from '@/domain/decision-engine'
import type { ShadowDifferenceClassification } from '@/domain/decision-engine/shadow'

export const SHADOW_TARGETS = ['local-v2', 'v2', 'v1-production-readonly'] as const
export type ShadowTarget = (typeof SHADOW_TARGETS)[number]

export interface ShadowSafetyRequest {
  target: ShadowTarget
  productionReadAcknowledged?: boolean
}

export interface ShadowRelevantFacts {
  factNames: readonly DecisionInputKey[]
  status: LeadDecisionContext['status']
  initialEmailMode: LeadDecisionContext['initialEmailMode']
  initialEmailState: LeadDecisionContext['initialEmail']['state']
  followUpStates: readonly LeadDecisionContext['initialEmail']['state'][]
  replyClassification: LeadDecisionContext['reply']['classification']
  suppressed: boolean
  duplicate: boolean
  manualSource: boolean
  categoryDisposition: 'available' | 'missing_or_unknown'
}

export interface ShadowComparisonResult {
  leadId: string
  legacyAction: DecisionAction
  v2Action: DecisionAction
  classification: ShadowDifferenceClassification
  reason: {
    v2ReasonCode: DecisionReasonCode
    comparisonNote: string
  }
  relevantFacts: ShadowRelevantFacts
  timestamp: string
  source: string
  sampleCohort?: string
  correlationId?: string
}

export type ShadowEvaluationOutcome =
  | { ok: true; result: ShadowComparisonResult }
  | { ok: false; leadId: string; error: string }

export interface ShadowComparisonSummary {
  totalEvaluated: number
  failedEvaluationCount: number
  classifications: Record<ShadowDifferenceClassification, number>
  actionDistribution: Record<string, number>
  reasonDistribution: Record<string, number>
  statusDistribution: Record<string, number>
}
