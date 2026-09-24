import {
  ALCOHOL_FOCUS_STATUSES,
  GAMBLING_BUSINESS_STATUSES,
  HALAL_STATUSES,
  PORK_EVIDENCE_STATUSES,
  RELIGIOUS_INSTITUTION_STATUSES,
  SHISHA_FOCUS_STATUSES,
  type CategoryPolicyFacts,
} from './types'

function member<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

/** Missing or malformed facts remain unknown; this function never infers facts. */
export function normalizeCategoryPolicyFacts(value: unknown): CategoryPolicyFacts {
  const facts = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    halalStatus: member(facts.halalStatus, HALAL_STATUSES, 'unknown'),
    alcoholFocus: member(facts.alcoholFocus, ALCOHOL_FOCUS_STATUSES, 'unknown'),
    porkEvidence: member(facts.porkEvidence, PORK_EVIDENCE_STATUSES, 'unknown'),
    gamblingBusiness: member(facts.gamblingBusiness, GAMBLING_BUSINESS_STATUSES, 'unknown'),
    religiousInstitution: member(facts.religiousInstitution, RELIGIOUS_INSTITUTION_STATUSES, 'unknown'),
    shishaFocused: member(facts.shishaFocused, SHISHA_FOCUS_STATUSES, 'unknown'),
  }
}
