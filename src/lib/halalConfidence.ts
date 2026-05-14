import {
  HALAL_FILTER_CATEGORIES,
  HALAL_QUALIFICATION_THRESHOLD,
  isHalalFilterCategory,
  scoreHalalQualification,
} from '@/lib/halalQualification'

export type HalalConfidenceResult = {
  score: number
  positiveKeywords: string[]
  negativeKeywords: string[]
}

export const HALAL_CONFIDENCE_HIGH_THRESHOLD = 70
export const HALAL_CONFIDENCE_LOW_THRESHOLD = HALAL_QUALIFICATION_THRESHOLD
export { HALAL_FILTER_CATEGORIES, isHalalFilterCategory }

export function scoreHalalConfidence(text: string): HalalConfidenceResult {
  const result = scoreHalalQualification({
    name: '',
    websiteText: text,
    categories: [],
    reviewTexts: [],
  })

  return {
    score: result.confidence,
    positiveKeywords: result.reasons,
    negativeKeywords: result.negativeSignals,
  }
}
