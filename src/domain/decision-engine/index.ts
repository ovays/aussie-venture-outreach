export { decideNextAction } from './decide'
export { decideContactedOutreach, sentStage } from './adapters'
export type { ContactedOutreachDecisionInput } from './adapters'
export { compareDecisionWithLegacy, compareDecisionWithLifecycleProjection, deriveLegacyIntendedAction } from './shadow'
export type { DecisionShadowComparison, LifecycleProjectionDecision, ShadowDifferenceClassification } from './shadow'
export { loadDecisionContext, loadDecisionContexts, MAX_DECISION_CONTEXT_BATCH } from './context-loader'
export type { DecisionContextLoaderOptions, DecisionContextLoadResult } from './context-loader'
export {
  getLifecycleTransition,
  isCanonicalLeadStatus,
  isLifecycleTransitionAllowed,
  LIFECYCLE_TRANSITIONS,
  TERMINAL_LEAD_STATUSES,
} from './transitions'
export type { LifecycleTransition, TransitionActor } from './transitions'
export {
  DECISION_ACTIONS,
  DECISION_REASON_CODES,
  DEFAULT_DECISION_SCHEDULE,
  REPLY_CLASSIFICATIONS,
} from './types'
export type {
  DecisionAction,
  DecisionEmailStage,
  DecisionInputKey,
  DecisionReasonCode,
  EmailStageState,
  LeadDecisionContext,
  LeadDecisionResult,
  ReplyClassification,
} from './types'
