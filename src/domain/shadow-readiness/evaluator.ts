import { compareDecisionWithLegacy, type LeadDecisionContext } from '@/domain/decision-engine'
import { assertShadowSafeExecution } from './safety'
import type { ShadowComparisonResult, ShadowSafetyRequest } from './types'

export interface ShadowEvaluationObserver {
  recordComparison(result: ShadowComparisonResult): Promise<void>
}

export interface EvaluateLeadShadowDependencies {
  loadContext(leadId: string): Promise<LeadDecisionContext | null>
  safety: ShadowSafetyRequest
  environment?: NodeJS.ProcessEnv
  observer?: ShadowEvaluationObserver
  source: string
  sampleCohort?: string
  correlationId?: string
  now?: () => Date
}

export async function evaluateLeadShadow(
  leadId: string,
  dependencies: EvaluateLeadShadowDependencies,
): Promise<ShadowComparisonResult> {
  const safety = assertShadowSafeExecution(dependencies.safety, dependencies.environment)
  if (dependencies.observer && !safety.observabilityWriteEnabled) {
    throw new Error('Shadow observability sink supplied while SHADOW_OBSERVABILITY_WRITE_ENABLED is false.')
  }
  const context = await dependencies.loadContext(leadId)
  if (!context) throw new Error(`Lead ${leadId} was not found.`)
  const comparison = compareDecisionWithLegacy(context)
  const result: ShadowComparisonResult = {
    leadId,
    legacyAction: comparison.legacyAction,
    v2Action: comparison.engine.action,
    classification: comparison.classification,
    reason: { v2ReasonCode: comparison.engine.reasonCode, comparisonNote: comparison.note },
    relevantFacts: {
      factNames: comparison.engine.inputsUsed,
      status: context.status,
      initialEmailMode: context.initialEmailMode,
      initialEmailState: context.initialEmail.state,
      followUpStates: [context.followUps.followUp1.state, context.followUps.followUp2.state, context.followUps.followUp3.state],
      replyClassification: context.reply.classification,
      suppressed: context.suppressed,
      duplicate: context.duplicate || context.operationalFacts?.openDuplicateFlag === true,
      manualSource: context.operationalFacts?.manualSource === true,
      categoryDisposition: context.operationalFacts?.categoryIdPresent === false ? 'missing_or_unknown' : 'available',
    },
    timestamp: (dependencies.now?.() ?? new Date()).toISOString(),
    source: dependencies.source,
    sampleCohort: dependencies.sampleCohort,
    correlationId: dependencies.correlationId,
  }
  await dependencies.observer?.recordComparison(result)
  return result
}
