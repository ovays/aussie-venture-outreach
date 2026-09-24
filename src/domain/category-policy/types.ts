export const HALAL_STATUSES = ['confirmed', 'not_halal', 'unknown', 'not_applicable'] as const
export type HalalStatus = (typeof HALAL_STATUSES)[number]

export const ALCOHOL_FOCUS_STATUSES = ['focused', 'serves_alcohol', 'no_evidence', 'unknown', 'not_applicable'] as const
export type AlcoholFocus = (typeof ALCOHOL_FOCUS_STATUSES)[number]

export const PORK_EVIDENCE_STATUSES = ['confirmed_incompatible', 'no_evidence', 'unknown', 'not_applicable'] as const
export type PorkEvidence = (typeof PORK_EVIDENCE_STATUSES)[number]

export const GAMBLING_BUSINESS_STATUSES = ['confirmed', 'not_gambling', 'unknown', 'not_applicable'] as const
export type GamblingBusiness = (typeof GAMBLING_BUSINESS_STATUSES)[number]

export const RELIGIOUS_INSTITUTION_STATUSES = ['confirmed', 'not_religious_institution', 'unknown', 'not_applicable'] as const
export type ReligiousInstitution = (typeof RELIGIOUS_INSTITUTION_STATUSES)[number]

export const SHISHA_FOCUS_STATUSES = ['confirmed', 'not_shisha_focused', 'unknown', 'not_applicable'] as const
export type ShishaFocus = (typeof SHISHA_FOCUS_STATUSES)[number]

export interface CategoryPolicy {
  requiresHalalConfirmation: boolean
  excludeAlcoholFocused: boolean
  excludePork: boolean
  excludeGambling: boolean
  excludeReligiousInstitutions: boolean
  excludeShisha: boolean
}

export interface CategoryPolicyFacts {
  halalStatus: HalalStatus
  alcoholFocus: AlcoholFocus
  porkEvidence: PorkEvidence
  gamblingBusiness: GamblingBusiness
  religiousInstitution: ReligiousInstitution
  shishaFocused: ShishaFocus
}

export const CATEGORY_POLICY_OUTCOMES = ['CONTINUE', 'STOP', 'MANUAL_REVIEW'] as const
export type CategoryPolicyOutcome = (typeof CATEGORY_POLICY_OUTCOMES)[number]

export const CATEGORY_POLICY_REASON_CODES = [
  'CATEGORY_POLICY_HALAL_NOT_HALAL',
  'CATEGORY_POLICY_HALAL_UNKNOWN',
  'CATEGORY_POLICY_ALCOHOL_FOCUSED',
  'CATEGORY_POLICY_ALCOHOL_UNKNOWN',
  'CATEGORY_POLICY_PORK_INCOMPATIBLE',
  'CATEGORY_POLICY_PORK_UNKNOWN',
  'CATEGORY_POLICY_GAMBLING',
  'CATEGORY_POLICY_GAMBLING_UNKNOWN',
  'CATEGORY_POLICY_RELIGIOUS_INSTITUTION',
  'CATEGORY_POLICY_RELIGIOUS_INSTITUTION_UNKNOWN',
  'CATEGORY_POLICY_SHISHA_FOCUSED',
  'CATEGORY_POLICY_SHISHA_UNKNOWN',
] as const

export type CategoryPolicyReasonCode = (typeof CATEGORY_POLICY_REASON_CODES)[number]

export interface CategoryPolicyReason {
  code: CategoryPolicyReasonCode
  message: string
}

export interface CategoryPolicyEvaluation {
  outcome: CategoryPolicyOutcome
  reasons: readonly CategoryPolicyReason[]
}
