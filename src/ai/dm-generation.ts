import { aiRegistry } from './AIRuntime'
import { contentTypeBrandPrefix, normalizeContentType, type ContentType } from '../lib/content-type'
import { getCategoryReferenceNoun, getContentFocus } from '../lib/category-copy'

// Aussie Venture is always described as one consistent lifestyle brand — never
// redefined per category (no "activities and entertainment platform" for one
// business and "food, travel and lifestyle platform" for another).
export function getBrandDescription(_category: string, contentType: ContentType): string {
  const prefix = contentTypeBrandPrefix(contentType)
  const article = prefix === 'Sydney-based' ? 'a' : 'an'
  return `${article} ${prefix} lifestyle platform`
}

function getCategoryPitch(category: string, contentType: ContentType): string {
  const focus = getContentFocus(category, contentType)
  const noun = getCategoryReferenceNoun(category)
  return `Owais creates ${focus} for 650K+ Australians and wants to collab with this ${noun}.`
}

export function buildOutreachDMPrompt(
  params: { business_name: string; suburb: string; city: string; category: string },
  brandDesc: string,
  pitch: string
): string {
  return `You're Owais. You run Aussie Venture, ${brandDesc} with 650K+ followers across Facebook, Instagram and TikTok. Write a short Instagram DM to this business.

Business: ${params.business_name}, ${params.suburb} ${params.city}
Category: ${params.category}

Pitch angle: ${pitch}

Rules:
- Max 2-3 sentences
- Sound like a real person, not a platform
- No em dashes, no bullet points, no corporate language
- No "I wanted to reach out", no "I came across your page"
- You may mention 650K+ followers once if it adds credibility
- NEVER mention free, no cost, no charge, or anything being free
- NEVER say "paid collab" - use "sponsored feature" or "collab" instead
- Never state a price
- Never say "I'm based in ${params.city}" or otherwise claim you live in, are based in, or are physically located in the business's city — Aussie Venture's audience is national, don't invent a location for yourself
- Never invent familiarity with the business — you only know its name, category and suburb. No claims implying you already know their page, food, or space
- Casual and direct
- End with "Would you be keen?" or "Keen to work together?"

Respond with just the DM text, nothing else.`
}

export async function writeOutreachDM(params: {
  business_name: string
  suburb: string
  city: string
  category: string
  content_type: string
}): Promise<string> {
  const contentType = normalizeContentType(params.content_type)
  const brandDesc = getBrandDescription(params.category, contentType)
  const pitch = getCategoryPitch(params.category, contentType)

  const response = await aiRegistry.generate('outreach_dm_generation', {
    maxTokens: 200,
    messages: [{ role: 'user', content: buildOutreachDMPrompt(params, brandDesc, pitch) }],
  })

  return response.text
}
