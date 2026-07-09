export type ContentType = 'visit' | 'remote'

// Categories where Sydney leads get in-person "visit" content by default.
// Preserved exactly as the legacy rule for any category with no per-city config yet.
export const VISIT_ELIGIBLE_CATEGORIES: string[] = [
  'Halal Restaurants', 'Halal Cafes', 'Halal Bakeries / Dessert Shops',
  'Nail Salons', 'Hair Salons', 'Beauty / Lash Studios',
  'Spas / Massage Studios', 'Hotels / Resorts',
]

export type ContentTypeCategory = {
  name: string
  content_type?: string | null
  city_content_types?: Record<string, string> | null
}

export function resolveContentType(
  category: ContentTypeCategory | null | undefined,
  city: string | null | undefined,
): ContentType {
  const override = city ? category?.city_content_types?.[city] : undefined
  if (override === 'visit' || override === 'remote') return override

  const isSydney = city?.toLowerCase() === 'sydney'
  return isSydney && VISIT_ELIGIBLE_CATEGORIES.includes(category?.name ?? '') ? 'visit' : 'remote'
}

// Coerces an untrusted/nullable content_type value (e.g. straight off a lead row) into a ContentType,
// defaulting to 'remote' — the single fallback rule for every email/DM generator.
export function normalizeContentType(value: string | null | undefined): ContentType {
  return value === 'visit' ? 'visit' : 'remote'
}

// Single source of truth for the "Sydney-based" vs "Australian" platform wording used across
// outreach emails, reactivation emails and DMs. visit → Sydney-based, remote → Australian.
export function contentTypeBrandPrefix(contentType: ContentType): string {
  return contentType === 'visit' ? 'Sydney-based' : 'Australian'
}

// Same rule as contentTypeBrandPrefix but without "-based", for copy like "Sydney venues" / "Australian venues".
export function contentTypeLocationWord(contentType: ContentType): string {
  return contentType === 'visit' ? 'Sydney' : 'Australian'
}
