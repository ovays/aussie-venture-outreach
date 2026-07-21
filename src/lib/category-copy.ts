import { type ContentType, contentTypeBrandPrefix, contentTypeLocationWord } from './content-type'

// Single source of truth for turning a category NAME (any string, including ones
// that don't exist yet) into the generic wording used across every email/DM template.
// New categories get correct wording automatically because classification is
// keyword-based, not a hardcoded list of known category names.

export type CategoryGroup = 'food' | 'beauty' | 'travel' | 'accommodation' | 'activity' | 'general'

// activity is checked ahead of travel below (Object.keys order) so venues like
// "Indoor Adventure" resolve to activity rather than travel's broader 'adventure' keyword.
const GROUP_KEYWORDS: Record<Exclude<CategoryGroup, 'general'>, string[]> = {
  food: ['restaurant', 'cafe', 'café', 'baker', 'dessert', 'food', 'dining', 'eatery', 'kitchen', 'grill'],
  beauty: ['salon', 'beauty', 'lash', 'nail', 'hair', 'spa', 'massage', 'wellness', 'barber', 'brow', 'skin'],
  accommodation: ['hotel', 'resort', 'accommodation', 'stay', 'motel', 'apartment', 'lodge', 'bnb', 'b&b', 'hostel'],
  activity: [
    'escape room', 'vr experience', 'quiz room', 'kart', 'bowling', 'mini golf', 'arcade',
    'laser tag', 'indoor adventure', 'trampoline', 'climbing', 'axe throwing', 'theme park',
    'wildlife park', 'aquarium', 'cruise', 'kayak',
  ],
  travel: ['travel', 'tour', 'holiday', 'excursion', 'adventure'],
}

export function classifyCategory(categoryName: string): CategoryGroup {
  const name = categoryName.toLowerCase()
  for (const group of Object.keys(GROUP_KEYWORDS) as (keyof typeof GROUP_KEYWORDS)[]) {
    if (GROUP_KEYWORDS[group].some((kw) => name.includes(kw))) return group
  }
  return 'general'
}

// "Halal" isn't a category type of its own — it's a modifier detected the same
// way (by keyword), so "Halal Butchers" gets halal wording without a new group.
function isHalal(categoryName: string): boolean {
  return categoryName.toLowerCase().includes('halal')
}

// Descriptive noun for "feature your ___" style copy — richer than the reference
// noun below, used where a bit of personality reads well.
export function getCategoryNoun(categoryName: string): string {
  switch (classifyCategory(categoryName)) {
    case 'food': return 'restaurant or cafe'
    case 'beauty': return 'studio or salon'
    case 'travel': return 'travel experience'
    case 'accommodation': return 'place to stay'
    case 'activity': return 'activity or entertainment venue'
    default: return 'business'
  }
}

// Plain reference noun for "this ___" / "the ___" style copy, where a business
// still needs to read naturally as an entity (a "travel experience" doesn't).
export function getCategoryReferenceNoun(categoryName: string): string {
  switch (classifyCategory(categoryName)) {
    case 'accommodation': return 'property'
    case 'activity': return 'venue'
    default: return 'business'
  }
}

// "food, travel and lifestyle" / "lifestyle" / "travel and lifestyle" — the
// descriptor slotted into "an Australian ${prefix} X platform".
export function getBrandFocus(categoryName: string): string {
  switch (classifyCategory(categoryName)) {
    case 'food': return 'food, travel and lifestyle'
    case 'beauty': return 'lifestyle'
    case 'travel': return 'travel and lifestyle'
    case 'accommodation': return 'travel and lifestyle'
    case 'activity': return 'activities and entertainment'
    default: return 'lifestyle'
  }
}

// "halal food content" / "lifestyle content" / etc, with the visit/remote
// location prefix threaded through every group consistently.
export function getContentFocus(categoryName: string, contentType: ContentType): string {
  const prefix = contentTypeBrandPrefix(contentType)
  switch (classifyCategory(categoryName)) {
    case 'food': return isHalal(categoryName) ? `${prefix} halal food content` : `${prefix} food content`
    case 'beauty': return `${prefix} lifestyle content`
    case 'travel': return `${prefix} travel content`
    case 'accommodation': return `${prefix} travel experiences and places-to-stay content`
    case 'activity': return `${prefix} activities and entertainment content`
    default: return `${prefix} lifestyle content`
  }
}

// "Sydney halal dining spots" / "Australian wellness and spa spots" / etc, used
// for reactivation copy ("planning a new round of ___").
export function getReactivationFocus(categoryName: string, contentType: ContentType): string {
  const name = categoryName.toLowerCase()
  const location = contentTypeLocationWord(contentType)

  switch (classifyCategory(categoryName)) {
    case 'food':
      if (/dessert|baker/.test(name)) return `${location} dessert and cafe spots`
      return isHalal(categoryName) ? `${location} halal dining spots` : `${location} dining spots`
    case 'beauty':
      if (/spa|massage|wellness/.test(name)) return `${location} wellness and spa spots`
      return `${location} beauty and lifestyle venues`
    case 'accommodation':
      return `${location} travel experiences and places to stay`
    case 'activity':
      if (/theme park|wildlife park|aquarium/.test(name)) return `${location} family attractions`
      return `${location} activities and attractions`
    case 'travel':
      return `${location} travel experiences`
    default:
      return `${location} venues and businesses`
  }
}
