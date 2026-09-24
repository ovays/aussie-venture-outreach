import type { LeadStatus } from '@/lib/lead-status'
import type { InitialEmailMode } from '@/lib/settingsDefaults'
import { CATEGORY_POLICY_REASON_CODES } from '@/domain/category-policy'
import type { CategoryPolicy, CategoryPolicyFacts, CategoryPolicyReason } from '@/domain/category-policy'

export const DECISION_ACTIONS = [
  'STOP',
  'RESEARCH',
  'GENERATE_INITIAL',
  'SEND_INITIAL',
  'WAIT',
  'SEND_FOLLOWUP_1',
  'SEND_FOLLOWUP_2',
  'SEND_FOLLOWUP_3',
  'REACTIVATE',
  'HANDLE_REPLY',
  'MARK_DEAD',
  'MANUAL_REVIEW',
] as const

export type DecisionAction = (typeof DECISION_ACTIONS)[number]

export const REPLY_CLASSIFICATIONS = [
  'INTERESTED',
  'NOT_INTERESTED',
  'PRICING',
  'INFO_REQUEST',
  'REFERRAL',
  'OUT_OF_OFFICE',
  'UNSUBSCRIBE',
  'UNCLEAR',
] as const

export type ReplyClassification = (typeof REPLY_CLASSIFICATIONS)[number]

export const DECISION_REASON_CODES = [
  'DUPLICATE_LEAD',
  'SUPPRESSED',
  'UNSUBSCRIBED',
  'TERMINAL_STATUS',
  'ACTIVE_DEAL_STATUS',
  'REPLY_RECEIVED',
  'REPLY_CLASSIFICATION_REQUIRED',
  'OUT_OF_OFFICE',
  'MISSING_EMAIL',
  'TEMPLATE_READY',
  'TEMPLATE_RESEARCH_REQUIRED',
  'TEMPLATE_CONFIGURATION_INVALID',
  'TEMPLATE_DATA_UNAVAILABLE',
  'PERSONALIZED_RESEARCH_REQUIRED',
  'INITIAL_CONTENT_REQUIRED',
  'INITIAL_CONTENT_READY',
  'INITIAL_SEND_UNCERTAIN',
  'STATUS_CONTENT_MISMATCH',
  'FOLLOWUP_1_READY',
  'FOLLOWUP_2_READY',
  'FOLLOWUP_3_READY',
  'FOLLOWUP_NOT_DUE',
  'FOLLOWUP_SEND_UNCERTAIN',
  'FOLLOWUP_SEQUENCE_COMPLETE',
  'INITIAL_SEND_MISSING',
  'REACTIVATION_DISABLED',
  'REACTIVATION_NOT_DUE',
  'REACTIVATION_READY',
  'REACTIVATION_ALREADY_SENT',
  'REACTIVATION_DEADLINE_REACHED',
  'MANUAL_OVERRIDE_REQUIRED',
  'MANUAL_SOURCE',
  'RECIPIENT_OWNED_BY_OTHER',
  'CATEGORY_CONTEXT_REQUIRED',
  ...CATEGORY_POLICY_REASON_CODES,
] as const

export type DecisionReasonCode = (typeof DECISION_REASON_CODES)[number]

export type EmailStageState = 'missing' | 'pending' | 'sent' | 'uncertain'

export interface DecisionEmailStage {
  state: EmailStageState
  sentAt: string | null
}

export interface LeadDecisionContext {
  leadId: string
  status: LeadStatus
  email: string | null
  duplicate: boolean
  suppressed: boolean
  dealState: 'none' | 'active' | 'closed'
  initialEmailMode: InitialEmailMode
  research: {
    contactDiscoveryComplete: boolean
    personalisationComplete: boolean
    canSupplyTemplateFields: boolean
  }
  template: {
    available: boolean
    requiredDataAvailable: boolean
  }
  initialEmail: DecisionEmailStage
  followUps: {
    followUp1: DecisionEmailStage
    followUp2: DecisionEmailStage
    followUp3: DecisionEmailStage
  }
  reply: {
    received: boolean
    classification: ReplyClassification | null
  }
  reactivation: {
    enabled: boolean
    sentAt: string | null
  }
  schedule: {
    followUp1Days: number
    followUp2Days: number
    followUp3Days: number
    deadLeadDays: number
    reactivationDelayDays: number
    deadAfterReactivationDays: number
  }
  asOf: string
  manualOverride: {
    requestedStatus: LeadStatus | null
  } | null
  categoryPolicy?: {
    categoryId: string
    policy: CategoryPolicy
    facts: CategoryPolicyFacts
  } | null
  operationalFacts?: {
    categoryIdPresent: boolean
    hasUsableCategoryContext: boolean
    manualSource: boolean
    recipientOwnership: 'owned_by_lead' | 'owned_by_other' | 'unclaimed' | 'unknown'
    openDuplicateFlag: boolean
  }
}

export type DecisionInputKey =
  | keyof LeadDecisionContext
  | `research.${keyof LeadDecisionContext['research']}`
  | `template.${keyof LeadDecisionContext['template']}`
  | `initialEmail.${keyof DecisionEmailStage}`
  | `followUps.${keyof LeadDecisionContext['followUps']}`
  | `reply.${keyof LeadDecisionContext['reply']}`
  | `reactivation.${keyof LeadDecisionContext['reactivation']}`
  | `schedule.${keyof LeadDecisionContext['schedule']}`
  | `manualOverride.${keyof NonNullable<LeadDecisionContext['manualOverride']>}`
  | 'categoryPolicy'
  | `operationalFacts.${keyof NonNullable<LeadDecisionContext['operationalFacts']>}`

export type DecisionMetadataValue = string | number | boolean | null

export interface LeadDecisionResult {
  action: DecisionAction
  reasonCode: DecisionReasonCode
  leadId: string
  inputsUsed: readonly DecisionInputKey[]
  reasons?: readonly CategoryPolicyReason[]
  metadata?: Readonly<Record<string, DecisionMetadataValue>>
}

export const DEFAULT_DECISION_SCHEDULE: LeadDecisionContext['schedule'] = {
  followUp1Days: 7,
  followUp2Days: 14,
  followUp3Days: 21,
  deadLeadDays: 21,
  reactivationDelayDays: 60,
  deadAfterReactivationDays: 14,
}
