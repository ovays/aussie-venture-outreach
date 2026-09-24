import type {
  CategoryPolicy,
  CategoryPolicyEvaluation,
  CategoryPolicyFacts,
  CategoryPolicyReason,
} from './types'

const STOP_CODES = new Set([
  'CATEGORY_POLICY_HALAL_NOT_HALAL',
  'CATEGORY_POLICY_ALCOHOL_FOCUSED',
  'CATEGORY_POLICY_PORK_INCOMPATIBLE',
  'CATEGORY_POLICY_GAMBLING',
  'CATEGORY_POLICY_RELIGIOUS_INSTITUTION',
  'CATEGORY_POLICY_SHISHA_FOCUSED',
])

export function evaluateCategoryPolicy(input: {
  policy: CategoryPolicy
  facts: CategoryPolicyFacts
}): CategoryPolicyEvaluation {
  const { policy, facts } = input
  const reasons: CategoryPolicyReason[] = []

  if (policy.requiresHalalConfirmation) {
    if (facts.halalStatus === 'not_halal') reasons.push({ code: 'CATEGORY_POLICY_HALAL_NOT_HALAL', message: 'Verified facts identify the business as not halal' })
    else if (facts.halalStatus === 'unknown') reasons.push({ code: 'CATEGORY_POLICY_HALAL_UNKNOWN', message: 'Halal confirmation is required but remains unknown' })
  }
  if (policy.excludeAlcoholFocused) {
    if (facts.alcoholFocus === 'focused') reasons.push({ code: 'CATEGORY_POLICY_ALCOHOL_FOCUSED', message: 'Verified facts identify an alcohol-focused business' })
    else if (facts.alcoholFocus === 'unknown') reasons.push({ code: 'CATEGORY_POLICY_ALCOHOL_UNKNOWN', message: 'Alcohol focus could not be determined' })
  }
  if (policy.excludePork) {
    if (facts.porkEvidence === 'confirmed_incompatible') reasons.push({ code: 'CATEGORY_POLICY_PORK_INCOMPATIBLE', message: 'Verified facts confirm a pork-focused or incompatible offering' })
    else if (facts.porkEvidence === 'unknown') reasons.push({ code: 'CATEGORY_POLICY_PORK_UNKNOWN', message: 'Pork compatibility could not be determined' })
  }
  if (policy.excludeGambling) {
    if (facts.gamblingBusiness === 'confirmed') reasons.push({ code: 'CATEGORY_POLICY_GAMBLING', message: 'Verified business type is primarily gambling or betting' })
    else if (facts.gamblingBusiness === 'unknown') reasons.push({ code: 'CATEGORY_POLICY_GAMBLING_UNKNOWN', message: 'Gambling business status could not be determined' })
  }
  if (policy.excludeReligiousInstitutions) {
    if (facts.religiousInstitution === 'confirmed') reasons.push({ code: 'CATEGORY_POLICY_RELIGIOUS_INSTITUTION', message: 'Verified business type is a religious institution' })
    else if (facts.religiousInstitution === 'unknown') reasons.push({ code: 'CATEGORY_POLICY_RELIGIOUS_INSTITUTION_UNKNOWN', message: 'Religious-institution status could not be determined' })
  }
  if (policy.excludeShisha) {
    if (facts.shishaFocused === 'confirmed') reasons.push({ code: 'CATEGORY_POLICY_SHISHA_FOCUSED', message: 'Verified facts identify a shisha or hookah-focused business' })
    else if (facts.shishaFocused === 'unknown') reasons.push({ code: 'CATEGORY_POLICY_SHISHA_UNKNOWN', message: 'Shisha or hookah focus could not be determined' })
  }

  return {
    outcome: reasons.some((reason) => STOP_CODES.has(reason.code))
      ? 'STOP'
      : reasons.length > 0 ? 'MANUAL_REVIEW' : 'CONTINUE',
    reasons,
  }
}
