import { type ContentType, contentTypeBrandPrefix } from './content-type'

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

// ─── Follow-up reminder wording ──────────────────────────────────────────────

// Every follow-up and the reactivation email carries a one-sentence reminder of
// who we are, because a recipient who never opened the first email has no idea.
// The four families below are the fallback tier: any category name, including
// ones nobody has added yet, resolves to one of them via classifyCategory, so a
// new category gets a sensible reminder with no code change.
export type ReminderFamily = 'Food' | 'Experiences' | 'Travel' | 'Lifestyle'

const FAMILY_BY_GROUP: Record<CategoryGroup, ReminderFamily> = {
  food: 'Food',
  activity: 'Experiences',
  travel: 'Travel',
  accommodation: 'Travel',
  beauty: 'Lifestyle',
  general: 'Lifestyle',
}

const FAMILY_FOCUS: Record<ReminderFamily, string> = {
  Food: 'food content',
  Experiences: 'content featuring attractions and experiences',
  Travel: 'travel content',
  Lifestyle: 'lifestyle content',
}

export function getReminderFamily(categoryName: string): ReminderFamily {
  return FAMILY_BY_GROUP[classifyCategory(categoryName)]
}

// The content-noun half of the reminder sentence ("We create ___ across
// Instagram, TikTok and Facebook"). Deliberately NOT location-prefixed: the
// reminder's job is to say what we make, and "Sydney-based food content" in a
// follow-up to a Perth lead is the exact mistake content-type.ts exists to stop.
//
// Narrower wording is applied where the family noun is true but vague, using the
// same keyword matching as everything else in this file. An unrecognised name
// falls through to its family default rather than needing a new branch.
export function getCategoryReminderFocus(categoryName: string): string {
  const name = categoryName.toLowerCase()
  const group = classifyCategory(categoryName)

  switch (group) {
    case 'food':
      if (isHalal(categoryName)) return 'halal food content'
      if (/dessert|baker|patisserie/.test(name)) return 'food and dessert content'
      if (/cafe|café|coffee/.test(name)) return 'food and cafe content'
      return FAMILY_FOCUS.Food
    case 'accommodation':
      return 'travel and places-to-stay content'
    case 'beauty':
      if (/spa|massage|wellness/.test(name)) return 'lifestyle and wellness content'
      return FAMILY_FOCUS.Lifestyle
    default:
      return FAMILY_FOCUS[FAMILY_BY_GROUP[group]]
  }
}

// What we're working on now, in the reactivation email ("We're covering more ___
// at the moment"). See reactivationContextOptions in email-voice.ts for the
// sentence it lands in.
//
// These used to be phrases like "Sydney halal dining spots", "Australian beauty
// and lifestyle venues" and "Sydney activities and attractions". They read
// correctly and they read wrong: nobody who runs a restaurant calls it a dining
// spot, and "beauty and lifestyle venues" is a category header, not a thing you
// say. The wording came from the internal taxonomy because the taxonomy was what
// was to hand, and a reader can tell — being described in the vocabulary of the
// list you're on is the fastest way to read an email as bulk.
//
// So these are now plain plurals of the thing itself, with an ordinary "around
// Sydney" / "around Australia" instead of an adjectival "Sydney"/"Australian".
// "more halal restaurants around Sydney" is what someone would say on the phone.
//
// Note contentTypeLocationWord is deliberately NOT used here: it yields the
// adjective form ("Sydney" / "Australian"), and "Australian restaurants" means
// cuisine, not location, which is a different and worse sentence.
export function getReactivationFocus(categoryName: string, contentType: ContentType): string {
  const name = categoryName.toLowerCase()
  const where = contentType === 'visit' ? 'around Sydney' : 'around Australia'
  const halal = isHalal(categoryName) ? 'halal ' : ''

  switch (classifyCategory(categoryName)) {
    case 'food':
      if (/dessert|baker|patisserie/.test(name)) return `${halal}bakeries and dessert places ${where}`
      if (/cafe|café|coffee/.test(name)) return `${halal}cafes ${where}`
      return `${halal}restaurants ${where}`
    case 'beauty':
      if (/spa|massage|wellness/.test(name)) return `spas and massage places ${where}`
      if (/nail/.test(name)) return `nail salons ${where}`
      if (/hair|barber/.test(name)) return `hair salons ${where}`
      if (/lash|brow/.test(name)) return `lash and brow studios ${where}`
      return `salons and studios ${where}`
    case 'accommodation':
      return `hotels and places to stay ${where}`
    case 'activity':
      if (/theme park|wildlife park|aquarium/.test(name)) return `days out ${where}`
      return `things to do ${where}`
    case 'travel':
      return `travel and tours ${where}`
    default:
      return `businesses like yours ${where}`
  }
}
