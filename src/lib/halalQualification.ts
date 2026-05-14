export type HalalClassification = 'Clearly Halal' | 'Likely Halal' | 'Uncertain' | 'Probably Not Halal'

export type HalalQualificationInput = {
  name: string
  categories?: string[]
  websiteText?: string
  websiteUrl?: string | null
  reviewTexts?: string[]
  reviews?: number
}

export type HalalQualificationResult = {
  confidence: number
  classification: HalalClassification
  reasons: string[]
  negativeSignals: string[]
}

export const HALAL_QUALIFICATION_THRESHOLD = 40

export const HALAL_FILTER_CATEGORIES = new Set([
  'Halal Restaurants',
  'Halal Cafes',
  'Halal Bakeries / Dessert Shops',
])

const FOOD_CATEGORY_PATTERNS = [
  /\bhalal\b/i,
  /\brestaurants?\b/i,
  /\bcafes?\b/i,
  /\bbaker(y|ies)\b/i,
  /\bdessert\b/i,
  /\bfood\b/i,
  /\bkebabs?\b/i,
  /\bmiddle eastern\b/i,
  /\blebanese\b/i,
  /\bturkish\b/i,
  /\bpakistani\b/i,
  /\bafghan\b/i,
  /\bbangladeshi\b/i,
  /\bmediterranean\b/i,
]

const NEGATIVE_PATTERNS: Array<[RegExp, number, string]> = [
  [/\bbacon\b/i, -10, 'bacon mentioned'],
  [/\bpork\b/i, -50, 'pork detected'],
  [/\b(pub|bar)\b/i, -40, 'pub/bar detected'],
  [/\bmixed grill\b.{0,80}\bpork\b/i, -50, 'mixed grill with pork menu detected'],
]

const ALCOHOL_PATTERN = /\b(wine|beer|cocktails?|champagne|liquor|alcohol)\b/gi
const WINE_BAR_PATTERN = /\bwine\s+bar\b|\bbar\b.{0,40}\bwine\b/i
const NON_HALAL_BACON_PATTERN = /\b(non[-\s]?halal|pork)\b.{0,40}\bbacon\b|\bbacon\b.{0,40}\b(non[-\s]?halal|pork)\b/i
const JAPANESE_KOREAN_PATTERN = /\b(japanese|korean|sushi|ramen|izakaya|yakitori|tonkatsu|katsu|bbq)\b/i
const GENERIC_CAFE_PATTERN = /\b(cafe|coffee|espresso|brunch|breakfast)\b/i
const PORK_PATTERN = /\b(pork|ham|prosciutto)\b/i
const WEBSITE_HALAL_CERTIFIED_PATTERN = /\b(halal certified|certified halal|100%\s*halal)\b/i
const WEBSITE_FULLY_HALAL_PATTERN = /\b(fully halal|all meats? halal)\b/i
const WEBSITE_HALAL_PATTERN = /\b(halal|muslim friendly|muslim-friendly)\b/i
const REVIEW_FULLY_HALAL_PATTERN = /\b(fully halal|100%\s*halal|all meats? halal)\b/i
const REVIEW_HALAL_PATTERN = /\b(fully halal|halal food|halal restaurant|muslim friendly|muslim-friendly|zabiha|halal)\b/i
const HALAL_RESTAURANT_CATEGORY_PATTERN = /\bhalal[_\s-]*restaurant\b/i
const LEBANESE_PATTERN = /\blebanese\b/i
const TURKISH_PATTERN = /\bturkish\b/i
const PAKISTANI_PATTERN = /\bpakistani\b/i
const AFGHAN_PATTERN = /\bafghan\b/i
const BANGLADESHI_PATTERN = /\bbangladeshi\b/i
const KEBAB_PATTERN = /\bkebabs?\b/i
const SHAWARMA_PATTERN = /\bshawarma\b/i
const MIDDLE_EASTERN_PATTERN = /\bmiddle eastern\b/i
const MEDITERRANEAN_PATTERN = /\bmediterranean\b/i
const ARABIC_NAME_PATTERN = /\b(al|el|abu|ibn|bin|bint|habib|sultan|emir|shah|khan|ali|omar|yusuf|mohammad|muhammad|ahmad|hassan|hussein)\b/i
const MUSLIM_BRAND_PATTERN = /\b(al|yasmin|aseel|mandi|kebab|shawarma|zamzam|sultan|habib|hijazi|yemeni|damascus|beirut|cedar|cedars?)\b/i
const TRUSTED_HALAL_CHAIN_PATTERN = /\b(al\s*aseel|alaseel|al\s*yasmin|alyasmin|el\s*jannah|eljannah|mandi)\b/i
const TRUSTED_HALAL_DOMAIN_PATTERN = /\b(alaseel\.com\.au|alyasmin|eljannah)\b/i

export function isHalalFilterCategory(categoryName: string | null | undefined): boolean {
  const category = categoryName ?? ''
  if (HALAL_FILTER_CATEGORIES.has(category)) return true
  return FOOD_CATEGORY_PATTERNS.some((pattern) => pattern.test(category))
}

export function scoreHalalQualification(input: HalalQualificationInput): HalalQualificationResult {
  const websiteVisibleText = stripHtml(input.websiteText ?? '')
  const businessText = [input.name, (input.categories ?? []).join(' ')].join(' ').toLowerCase()
  const websiteText = websiteVisibleText.toLowerCase()
  const reviewTexts = input.reviewTexts ?? []
  const reviewText = reviewTexts.join(' ').toLowerCase()
  const websiteUrlText = input.websiteUrl?.toLowerCase() ?? ''
  const haystack = [businessText, websiteText, reviewText, websiteUrlText].join(' ')

  let score = 20
  const reasons: string[] = []
  const negativeSignals: string[] = []
  let hasExplicitHalalOverride = false
  let hasTrustedHalalChain = false

  if (WEBSITE_HALAL_CERTIFIED_PATTERN.test(websiteText)) {
    score += 50
    hasExplicitHalalOverride = true
    reasons.push(`halal certified evidence found on website: "${snippet(websiteVisibleText, WEBSITE_HALAL_CERTIFIED_PATTERN)}"`)
  } else if (WEBSITE_FULLY_HALAL_PATTERN.test(websiteText)) {
    score += 30
    hasExplicitHalalOverride = true
    reasons.push(`fully halal wording found on website: "${snippet(websiteVisibleText, WEBSITE_FULLY_HALAL_PATTERN)}"`)
  } else if (WEBSITE_HALAL_PATTERN.test(websiteText)) {
    score += 40
    hasExplicitHalalOverride = true
    reasons.push(`halal found on website: "${snippet(websiteVisibleText, WEBSITE_HALAL_PATTERN)}"`)
  }

  const halalReviewMatches = reviewTexts.filter((text) => REVIEW_HALAL_PATTERN.test(text))
  const fullyHalalReview = halalReviewMatches.find((text) => REVIEW_FULLY_HALAL_PATTERN.test(text))
  if (fullyHalalReview) {
    score += 35
    reasons.push(`review says fully halal: "${snippet(fullyHalalReview, REVIEW_FULLY_HALAL_PATTERN)}"`)
  }

  const reviewEvidence = halalReviewMatches.find((text) => text !== fullyHalalReview)
  if (reviewEvidence) {
    score += 25
    reasons.push(`review mentions halal: "${snippet(reviewEvidence, REVIEW_HALAL_PATTERN)}"`)
  }

  if (halalReviewMatches.length >= 2) hasExplicitHalalOverride = true

  if (TRUSTED_HALAL_CHAIN_PATTERN.test(businessText) || TRUSTED_HALAL_DOMAIN_PATTERN.test(websiteUrlText)) {
    score += 35
    hasTrustedHalalChain = true
    reasons.push('trusted halal chain/domain detected')
  }

  if (HALAL_RESTAURANT_CATEGORY_PATTERN.test(businessText)) {
    score += 40
    hasExplicitHalalOverride = true
    reasons.push('halal_restaurant category detected')
  }
  if (LEBANESE_PATTERN.test(businessText)) {
    score += 35
    reasons.push('lebanese_restaurant category or cuisine detected')
  }
  if (TURKISH_PATTERN.test(businessText)) {
    score += 25
    reasons.push('turkish_restaurant category or cuisine detected')
  }
  if (PAKISTANI_PATTERN.test(businessText)) {
    score += 35
    reasons.push('Pakistani cuisine detected')
  }
  if (AFGHAN_PATTERN.test(businessText)) {
    score += 35
    reasons.push('Afghan cuisine detected')
  }
  if (BANGLADESHI_PATTERN.test(businessText)) {
    score += 30
    reasons.push('bangladeshi_restaurant category or cuisine detected')
  }
  if (KEBAB_PATTERN.test(businessText)) {
    score += 25
    reasons.push('kebab_shop category or wording detected')
  }
  if (SHAWARMA_PATTERN.test(businessText)) {
    score += 20
    reasons.push('shawarma restaurant naming/cuisine detected')
  }
  if (MIDDLE_EASTERN_PATTERN.test(businessText)) {
    score += 30
    reasons.push('middle_eastern_restaurant category detected')
  }
  if (MEDITERRANEAN_PATTERN.test(businessText)) {
    score += 20
    reasons.push('mediterranean_restaurant category detected')
  }
  if (ARABIC_NAME_PATTERN.test(input.name.toLowerCase()) || MUSLIM_BRAND_PATTERN.test(input.name.toLowerCase())) {
    score += 20
    reasons.push('Arabic or Muslim restaurant naming convention detected')
  }

  for (const [pattern, points, reason] of NEGATIVE_PATTERNS) {
    const evidenceSource = firstEvidenceMatch(pattern, [
      { label: 'website', text: websiteVisibleText },
      { label: 'review', text: reviewTexts.join(' ') },
      { label: 'business/category', text: [input.name, (input.categories ?? []).join(' ')].join(' ') },
    ])
    if (evidenceSource) {
      score += points
      negativeSignals.push(`${reason}: "${evidenceSource}"`)
    }
  }

  const alcoholMatches = haystack.match(ALCOHOL_PATTERN) ?? []
  const alcoholMatchCount = new Set(alcoholMatches.map((match) => match.toLowerCase())).size
  if (alcoholMatchCount >= 2) {
    score -= 35
    negativeSignals.push('alcohol-heavy venue detected')
  }
  if (WINE_BAR_PATTERN.test(haystack)) {
    score -= 50
    negativeSignals.push('wine bar / explicit bar alcohol venue detected')
  }
  if (NON_HALAL_BACON_PATTERN.test(haystack)) {
    score -= 35
    negativeSignals.push('non-halal bacon menu evidence detected')
  }

  const hasHalalEvidence = WEBSITE_HALAL_PATTERN.test(websiteText) || REVIEW_HALAL_PATTERN.test(reviewText)

  if (JAPANESE_KOREAN_PATTERN.test(businessText) && !hasHalalEvidence) {
    score -= 15
    negativeSignals.push('Japanese/Korean restaurant with no halal evidence')
  }

  if (GENERIC_CAFE_PATTERN.test(businessText) && !hasHalalEvidence) {
    score -= 15
    negativeSignals.push('generic cafe with no halal evidence')
  }

  if (!PORK_PATTERN.test(haystack)) {
    reasons.push('no pork indicators')
    score += 5
  }

  if ((input.reviews ?? 0) >= 100) {
    reasons.push('strong review count')
    score += 5
  }

  const hasStrongNonHalalOverride =
    /\bpork\b/i.test(haystack) ||
    WINE_BAR_PATTERN.test(haystack) ||
    /\b(pub|bar)\b/i.test(haystack) ||
    alcoholMatchCount >= 2 ||
    NON_HALAL_BACON_PATTERN.test(haystack)

  if (hasTrustedHalalChain && !hasStrongNonHalalOverride && score < 80) {
    reasons.push('trusted halal chain/domain applied minimum confidence floor')
    score = 80
  }

  if (hasExplicitHalalOverride && !hasStrongNonHalalOverride && score < 85) {
    reasons.push('explicit halal evidence applied minimum confidence floor')
    score = 85
  }

  const confidence = Math.max(0, Math.min(100, score))
  return {
    confidence,
    classification: classifyConfidence(confidence),
    reasons: [...new Set(reasons)],
    negativeSignals: [...new Set(negativeSignals)],
  }
}

export function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
}

function classifyConfidence(confidence: number): HalalClassification {
  if (confidence >= 90) return 'Clearly Halal'
  if (confidence >= 70) return 'Likely Halal'
  if (confidence >= 40) return 'Uncertain'
  return 'Probably Not Halal'
}

function firstEvidenceMatch(pattern: RegExp, sources: Array<{ label: string; text: string }>): string | null {
  for (const source of sources) {
    const found = snippet(source.text, pattern)
    if (found) return `${source.label}: ${found}`
  }
  return null
}

function snippet(text: string, pattern: RegExp): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const match = normalized.match(pattern)
  if (!match?.index && match?.index !== 0) return null
  const start = Math.max(0, match.index - 45)
  const end = Math.min(normalized.length, match.index + match[0].length + 45)
  return normalized.slice(start, end)
}
